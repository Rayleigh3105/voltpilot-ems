package com.voltpilot.api.rules;

import com.voltpilot.api.repo.RuleEventRepository;
import com.voltpilot.api.web.dto.RuleEventsDto;
import com.voltpilot.api.web.dto.RuleEventsDto.RuleActivityDto;
import com.voltpilot.api.web.dto.RuleEventsDto.RuleEventDto;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die LESESEITE des Regel-Protokolls: aus dem Verlaufsspeicher werden die drei
 * Aussagen, die die Fläche braucht - der Zähler je Regel, der Ausschnitt je
 * Regel und das kompakte Gesamt-Protokoll (Stufe 5b, Teil 5b.6).
 *
 * <p>RLS ist der Zaun (der Aufrufer ist eine {@code /sites/**}-Kundenroute);
 * hier steht kein einziges Mandanten-Prädikat.
 */
@Service
public class RuleEventReader {

    /** So viele Zeilen trägt das Gesamt-Protokoll - der Rest ist Archiv. */
    static final int MAX_EVENTS = 200;

    private final RuleEventRepository store;

    public RuleEventReader(RuleEventRepository store) {
        this.store = store;
    }

    public RuleEventsDto forSite(UUID siteId, Instant now) {
        Instant recordingSince = store.recordingSince(siteId).orElse(null);
        Instant dayStart = RuleEvents.berlinDayStart(now);
        boolean zaehlerBelastbar = RuleEvents.tageszaehlerBelastbar(recordingSince, now);

        List<RuleActivityDto> rules = store
                .activity(siteId, dayStart, Set.of(RuleEvents.GESTARTET),
                        Set.of(RuleEvents.GESTARTET, RuleEvents.GESTOPPT))
                .stream()
                // Ein Zähler, den der Speicher nicht belegen kann, wird gar
                // nicht erst behauptet - die Fläche nennt dann den Beginn der
                // Aufzeichnung statt einer 0.
                .map(a -> zaehlerBelastbar ? a
                        : new RuleActivityDto(a.ruleKind(), a.ruleRef(), null, a.lastSwitchedAt()))
                .toList();

        List<RuleEventDto> events = store.events(siteId, MAX_EVENTS);
        return new RuleEventsDto(recordingSince, RuleEventWriter.ACCURACY_SECONDS,
                zaehlerBelastbar, rules, events);
    }
}
