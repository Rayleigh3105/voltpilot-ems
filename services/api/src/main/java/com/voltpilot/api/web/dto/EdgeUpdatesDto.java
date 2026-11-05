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
 *
 * <p>{@code lines} (Geräte &amp; Updates S0, additiv) trägt das neueste Release
 * und die Zählung JE LINIE - Docker-Box und Edge Light getrennt. Die
 * {@link KpiDto}-Felder bleiben unverändert für ältere Portale (dort gilt das
 * neueste Release über beide Linien).
 */
public record EdgeUpdatesDto(List<ReleaseDto> releases, List<RolloutDto> rollouts,
        List<FleetRowDto> fleet, List<EventDto> journal, KpiDto kpi, List<LineDto> lines) {

    /**
     * Eine Software-Linie: Docker-Box ({@code docker}, Releases
     * {@code edge-JJJJ.MM.N}) oder Edge Light ({@code light},
     * {@code edge-light-JJJJ.MM.N}).
     *
     * <p>{@code newestRelease}/{@code newestReleaseSeq} sind das neueste Release
     * DIESER Linie ({@code null} = die Linie hat noch keines). {@code devices}
     * zählt die Boxen der Linie ({@code ota.BoxArt}; eine Box unbekannter Art
     * zählt in keiner Linie, nie still als Docker-Box), {@code known} davon die,
     * die überhaupt einen Stand gemeldet haben, und {@code upToDate} die, die das
     * neueste Release der Linie melden ({@code ota.EdgeStandVerdict}, dieselbe
     * Regel wie auf der Kunden-Box-Seite).
     *
     * <p>Eine Linie steht nur in der Liste, wenn sie ein Release oder eine Box
     * hat; die Reihenfolge ist fest (Docker-Box, dann Edge Light).
     */
    public record LineDto(String boxArt, String newestRelease, Long newestReleaseSeq,
            int devices, int known, int upToDate,
            // Geräte & Updates G1 (additiv): die Linien-Sicht der Seite.
            int releases, java.util.Map<String, Integer> stand, List<LineVersionDto> versions) {
    }

    /**
     * Eine Sprosse der Versionsleiter einer Linie: ein Release (oder ein Stand,
     * den das Register nicht führt - {@code releaseSeq == null}) und die Boxen,
     * die ihn melden. Registrierte Releases neueste zuerst, danach die übrigen.
     */
    public record LineVersionDto(String version, Long releaseSeq, List<UUID> devices) {
    }

    /**
     * Die drei Fakten einer Anfrage (Geräte &amp; Updates G2, {@code ota.UpdateFakten}):
     * angefragt (Portal), angenommen (Box), bestätigt (Box), je mit Zeitpunkt
     * ({@code null} = unbekannt).
     */
    public record FaktenDto(AngefragtDto angefragt, AngenommenDto angenommen,
            BestaetigtDto bestaetigt) {
    }

    /** Angefragt: Release, Zeitpunkt und Person (bzw. {@code system}). */
    public record AngefragtDto(String release, long releaseSeq, Instant am, String von) {
    }

    /**
     * Angenommen: {@code ja}, {@code offen}, {@code wartet} (Box offline),
     * {@code abgelehnt}, {@code zurueckgestellt} - mit dem Grund der Box.
     */
    public record AngenommenDto(String stand, Instant am, String grund) {
    }

    /**
     * Bestätigt: {@code ja}, {@code offen}, {@code laeuft} (mit {@code schritt}
     * {@code laedt}/{@code wendet_an}/{@code selbsttest}), {@code fehlgeschlagen},
     * {@code zurueckgenommen}, {@code verstummt}.
     */
    public record BestaetigtDto(String stand, Instant am, String schritt, String grund) {
    }

    /**
     * Die Eignung aller Boxen der Linie eines Releases (Geräte &amp; Updates G1,
     * {@code GET /api/v1/admin/edge-updates/eignung}). {@code andereLinie} zählt
     * die Boxen der anderen Box-Art, die hier bewusst nicht stehen.
     */
    public record EignungDto(long releaseSeq, String version, String boxArt,
            List<EignungBoxDto> boxen, int andereLinie) {
    }

    /**
     * Eine Box im Verteil-Dialog: {@code gruppe} ist {@code bereit},
     * {@code wartet}, {@code aktuell} oder {@code kann_nicht} ({@code ota.UpdateEignung}),
     * {@code grund} der deutsche Satz dazu.
     */
    public record EignungBoxDto(UUID deviceId, String label, String externalRef, String siteName,
            String tenantName, String ist, String gruppe, String grund, Instant lastSeenAt) {
    }

    /**
     * Ein Eintrag des Release-Registers, neueste zuerst.
     *
     * <p>{@code signed} ist die Bedingung für einen Rollout: nur ein signiertes
     * Release kann verteilt werden, weil nur dann Manifest-Bytes existieren,
     * die ein Gerät gegen seine eingebackene Wurzel prüfen kann. Ein
     * Stufe-0-Eintrag liest sich ehrlich als „nicht signiert".
     *
     * <p>{@code boxArt} ist {@code docker} oder {@code light} ({@code ota.BoxArt}):
     * ohne Kennzeichnung im Manifest oder Namen gilt ein Release als Docker.
     * Nur Geräte derselben Box-Art bekommen es (409 sonst).
     */
    public record ReleaseDto(long releaseSeq, String version, String targetCommit, String notes,
            boolean signed, String signingKeyId, Instant createdAt, int runningOnDevices,
            String boxArt) {
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
     *
     * <p>{@code boxArt} ist {@code docker}, {@code light} oder {@code null} =
     * unbekannt (noch keine Meldung) - abgeleitet in {@code ota.BoxArt}, nie im
     * Portal geraten.
     */
    public record FleetRowDto(UUID deviceId, String label, String externalRef,
            UUID siteId, String siteName,
            UUID tenantId, String tenantName, String ist, String soll, Long sollSeq,
            String state, String reason, String blocker,
            Instant since, Instant reportedAt, UUID rolloutId, TrustDto trust,
            String boxArt,
            // Geräte & Updates G1/G2 (additiv):
            // lastSeenAt  - die EINE Uhr für „online" (Herzschlag, Serverzeit);
            // linie       - die Linie, an der gemessen wird (null = unbekannt);
            // stand       - ota.LinienStand (hand, fehler, offline, laeuft, gehalten,
            //               aktuell, aelter, unbekannt);
            // stufe1      - Edge Light ohne gekreuztes Vertrauen;
            // istRelease  - das Register-Release, das die Box fährt (null = nicht registriert);
            // releasesDahinter - wie viele Releases der Linie neuer sind (null = unbekannt);
            // istSeit     - seit wann der laufende Stand läuft (null = unbekannt);
            // fakten      - angefragt/angenommen/bestätigt der aktuellen Anfrage (null = keine).
            Instant lastSeenAt, String linie, String stand, boolean stufe1, String istRelease,
            Integer releasesDahinter, Instant istSeit, FaktenDto fakten) {
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
     *
     * <p>⚠ {@code upToDate} und {@code newestRelease} messen am neuesten
     * Release über BEIDE Linien - so lesen es ältere Portale, und dabei bleibt
     * es. Das Urteil je Linie trägt {@link LineDto} (Geräte &amp; Updates S0).
     */
    public record KpiDto(int known, int upToDate, int unknown, int inRollout, int failed,
            String newestRelease) {
    }
}
