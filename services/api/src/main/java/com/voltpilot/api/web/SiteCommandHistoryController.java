package com.voltpilot.api.web;

import com.voltpilot.api.command.CommandFilter;
import com.voltpilot.api.command.CommandLogReader;
import com.voltpilot.api.command.DeviceScopes;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.CommandHistoryDto;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der KOMMANDO-VERLAUF einer Anlage (Kommando-Transparenz V1, Konzept
 * {@code vp-kommando-transparenz-k3} §6.3) - mandantenbezogen wie jede
 * {@code /api/v1/sites/**}-Route ({@link SiteRuleEventController},
 * {@link SiteConsumerController}): KEIN {@code @PreAuthorize},
 * Authentifizierung + Postgres-RLS sind der Zaun, eine fremde Anlage ist 404
 * (nie 403), und ein Admin erreicht sie über den {@code X-Tenant-Id}-Umschalter
 * auf demselben RLS-Pfad.
 *
 * <p>Der Verlauf ist KUNDENDATEN - deshalb wohnt er hier und nicht unter
 * {@code /admin/**}, und deshalb ist seine Tabelle mandantengebunden statt
 * global wie {@code rollout_event}.
 *
 * <p><b>READ-ONLY, und das ist eine Konstruktions-Aussage:</b> diese Route
 * beobachtet nur. Wünsche → Arbitrierung → Schutzgrenzen → Executor bleiben
 * unangetastet, es entsteht kein Schreibpfad zu irgendeinem Gerät.
 *
 * <p>Eine Anlage ohne eine einzige aufgezeichnete Zeile bekommt eine
 * wohlgeformte LEERE Antwort ({@code entries} leer, {@code recordingSince} ggf.
 * null) - das ist der Normalzustand am Tag der Auslieferung und kein Fehler.
 *
 * <p><b>Die SUCHE (Geräteseiten Revision B §6, Captain-Punkt 4)</b> ist additiv:
 * ohne einen einzigen der neuen Parameter antwortet die Route zeichengleich wie
 * vorher. Struktur wird HIER gefiltert ({@code streams} · {@code sources} ·
 * {@code verdicts}), der FREITEXT bleibt bewusst im Portal - die deutschen
 * Sätze entstehen dort, und eine Server-Suche fände nur Rohfelder und
 * widerspräche damit dem, was der Kunde liest.
 *
 * <p>{@code range} kennt seit dieser Stufe zusätzlich {@code month}; ein
 * eigener Zeitraum reist als {@code from}/{@code to} (Kalendertage). Weiter als
 * die Aufbewahrung zurück wird ABGELEHNT statt still gekappt: ein Fenster, das
 * dahinter greift, fände nichts und läse sich als „damals wurde nichts
 * geschickt".
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteCommandHistoryController {

    private final Geltungsbereich geltungsbereich;
    private final CommandLogReader reader;
    private final DeviceScopes scopes;

    public SiteCommandHistoryController(Geltungsbereich geltungsbereich, CommandLogReader reader,
            DeviceScopes scopes) {
        this.geltungsbereich = geltungsbereich;
        this.reader = reader;
        this.scopes = scopes;
    }

    @GetMapping("/command-history")
    public CommandHistoryDto commandHistory(@PathVariable UUID siteId,
            @RequestParam(name = "entity", required = false) UUID entityId,
            @RequestParam(name = "device", required = false) String device,
            @RequestParam(name = "range", defaultValue = "day") String range,
            @RequestParam(name = "at", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at,
            @RequestParam(name = "from", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(name = "to", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(name = "streams", required = false) String streams,
            @RequestParam(name = "sources", required = false) String sources,
            @RequestParam(name = "verdicts", required = false) String verdicts,
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "before", required = false) Instant before) {
        geltungsbereich.requireSite(siteId);
        HistoryRange parsed = HistoryRange.parse(range);
        if (parsed == null || !CommandFilter.RANGES.contains(parsed)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannter Zeitraum - erlaubt sind 'day', 'week' und 'month'.");
        }
        if (entityId != null && device != null) {
            // Zwei verschiedene Fragen - „was ging an DIESE Komponente" und „was
            // ging an DIESES Gerät". Eine still zu bevorzugen hiesse, eine der
            // beiden Antworten unter dem falschen Etikett auszugeben.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Bitte entweder eine Komponente oder ein Gerät wählen, nicht beides.");
        }
        if (entityId != null && !reader.entityExists(siteId, entityId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        DeviceScopes.Scope scope = device == null ? null : scopes.resolve(siteId, device);
        if (device != null && scope == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        // ⚠ Jede Ablehnung nennt ihren Grund auf Deutsch: die Filter-Leiste ist
        // eine KUNDEN-Fläche, und ein nacktes 400 wäre dort keine Auskunft. Die
        // Regeln selbst leben rein in `CommandFilter` (Docker-frei prüfbar).
        CommandFilter.Filter filter;
        HistoryRange.Window window;
        int max;
        try {
            filter = CommandFilter.parse(streams, sources, verdicts);
            window = CommandFilter.window(parsed, at, from, to,
                    LocalDate.now(HistoryRange.ZONE));
            max = CommandFilter.limit(limit);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        Instant end = clampToNow(window.to());
        return reader.forSite(siteId, entityId, scope, window.from(), end, filter,
                CommandFilter.before(before, end), max);
    }

    /**
     * Jede Ablehnung erreicht die Oberfläche als deutscher {@code {message}}-Körper
     * (das {@code SiteChargingConfigController}-Muster).
     *
     * <p>Seit der Filter-Leiste ist das keine Kür mehr: sie ist eine
     * KUNDEN-Fläche, und ein nacktes 400 ohne Grund wäre dort keine Auskunft -
     * der Kunde sähe nur, dass „etwas nicht geht".
     */
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Object> handle(ResponseStatusException e) {
        HttpStatus status = HttpStatus.valueOf(e.getStatusCode().value());
        String message = e.getReason() == null ? status.getReasonPhrase() : e.getReason();
        return ResponseEntity.status(status).body(java.util.Map.of("message", message));
    }

    /**
     * Ein laufender Zeitraum endet JETZT, nicht am Kalenderrand: sonst trüge die
     * Antwort ein „bis" in der Zukunft, und eine offene Periode läse sich, als
     * sei sie bis Mitternacht belegt.
     */
    private static Instant clampToNow(Instant to) {
        Instant now = Instant.now();
        return to.isAfter(now) ? now : to;
    }
}
