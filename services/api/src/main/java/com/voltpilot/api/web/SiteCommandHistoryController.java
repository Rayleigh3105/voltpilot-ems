package com.voltpilot.api.web;

import com.voltpilot.api.command.CommandLogReader;
import com.voltpilot.api.command.DeviceScopes;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.CommandHistoryDto;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Set;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
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
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteCommandHistoryController {

    /**
     * Nur Tag und Woche. Ein Monat wäre bei ~130 Zeilen je Gerät und Tag ein
     * Fenster, das der Deckel ohnehin kappt - lieber gar nicht anbieten als eine
     * Antwort, die still unvollständig ist.
     */
    private static final Set<HistoryRange> RANGES = Set.of(HistoryRange.DAY, HistoryRange.WEEK);

    private final SiteRepository sites;
    private final CommandLogReader reader;
    private final DeviceScopes scopes;

    public SiteCommandHistoryController(SiteRepository sites, CommandLogReader reader,
            DeviceScopes scopes) {
        this.sites = sites;
        this.reader = reader;
        this.scopes = scopes;
    }

    @GetMapping("/command-history")
    public CommandHistoryDto commandHistory(@PathVariable UUID siteId,
            @RequestParam(name = "entity", required = false) UUID entityId,
            @RequestParam(name = "device", required = false) String device,
            @RequestParam(name = "range", defaultValue = "day") String range,
            @RequestParam(name = "at", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        HistoryRange parsed = HistoryRange.parse(range);
        if (parsed == null || !RANGES.contains(parsed)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannter Zeitraum - erlaubt sind 'day' und 'week'.");
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
        LocalDate anchor = at != null ? at : LocalDate.now(HistoryRange.ZONE);
        HistoryRange.Window window = parsed.window(anchor);
        return reader.forSite(siteId, entityId, scope, window.from(), clampToNow(window.to()));
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
