package com.voltpilot.api.ruhezeit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.ueberwachung.UeberwachungRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.RuhezeitPruefung;
import com.voltpilot.api.versand.VersandRepository;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Ruhezeit und Stummschaltung beim Versand (Alerting Scheibe 3, Konzept §6.4) - die echte
 * Implementierung von {@link RuhezeitPruefung}, die {@link com.voltpilot.api.versand.Zusteller} über
 * {@code @Autowired(required = false)} bekommt (dieselbe Entkopplung wie
 * {@code UeberwachungSichtPruefungImpl}).
 *
 * <p>Reihenfolge der Prüfungen: (1) ein inzwischen erledigter/gesehener Alarm braucht keine
 * (verspätete) Meldung mehr (Entscheid 3B) - eine "Wieder normal" dagegen entfällt nur, wenn ihre
 * eigene Auslösung endgültig unterdrückt wurde, nie wegen "erledigt" (das IST der Anlass selbst,
 * Einstellungen-Konzept Entscheid 5A: "Entwarnung wie Meldung halten und mit ihr entfallen");
 * (2) eine aktive Stummschaltung unterdrückt endgültig; (3) eine aktive Ruhezeit (Person ODER
 * Regel, das SPÄTERE Ende gilt) verschiebt - außer Dringend, wenn die Person "Dringendes trotzdem
 * melden" nicht abgeschaltet hat (Einstellungen-Konzept Entscheid 4A: gilt für JEDEN Weg gleich,
 * nicht nur Push).
 */
@Component
public class RuhezeitPruefungImpl implements RuhezeitPruefung {

    private static final ZoneId STANDARD_ZEITZONE = ZoneId.of("Europe/Berlin");

    /**
     * Die Vorgabe (B4, Entscheid 5A): wer die eigene Ruhezeit NIE anfasst, hat in
     * {@code ruhezeit_person} keine Zeile - {@code fuerVersand} lieferte dafür bisher
     * {@code Optional.empty()}, und ohne Person galt beim Versand NUR die Ruhezeit der Regel (oder gar
     * keine). Die Fläche zeigt für denselben Fall längst die Vorgabe „werktags 22 bis 7 Uhr, am
     * Wochenende ganz“ ({@code com.voltpilot.api.web.RuhezeitController.Zustand#vorgabe},
     * {@link RuhezeitService#VORGABE_REGELN_JSON}) - was angezeigt wird, muss auch gelten, darum
     * derselbe Wortlaut hier.
     */
    private static final RuhezeitRepository.RuhezeitPerson VORGABE = new RuhezeitRepository.RuhezeitPerson(
            vorgabeRegeln(), "Europe/Berlin", true);

    private final UeberwachungRepository ueberwachung;
    private final RuhezeitRepository ruhezeitRepo;
    private final VersandRepository versand;

    public RuhezeitPruefungImpl(UeberwachungRepository ueberwachung, RuhezeitRepository ruhezeitRepo,
            VersandRepository versand) {
        this.ueberwachung = ueberwachung;
        this.ruhezeitRepo = ruhezeitRepo;
        this.versand = versand;
    }

    @Override
    public Instant wannSenden(UUID alarmId, String empfaengerSub, String weg, String anlass, Instant jetzt) {
        boolean wiederNormal = "wieder_normal".equals(anlass);
        if (!"ausgeloest".equals(anlass) && !"erinnerung".equals(anlass) && !wiederNormal) {
            return jetzt; // zusammenfassung/bestaetigung: nie gehalten
        }
        AlarmZeile alarm = ueberwachung.alarm(alarmId).orElse(null);
        if (alarm == null) {
            return jetzt; // schon weg (Löschlauf einer späteren Scheibe) - nichts zu halten
        }
        if (wiederNormal) {
            // B7: die Entwarnung meldet selbst, dass der Alarm gerade "erledigt" wurde - der 3B-
            // Filter unten träfe sie also IMMER und ist hier falsch. Sie entfällt stattdessen nur,
            // wenn ihre eigene Auslösung für genau diesen Empfänger/Weg endgültig unterdrückt wurde
            // (nie angekommen, nie nachkommend) - sonst hält sie wie die Auslösung selbst.
            if (versand.ausloesungWurdeUnterdrueckt(alarmId, empfaengerSub, weg)) {
                return Instant.MAX;
            }
        } else {
            if ("erledigt".equals(alarm.zustand())) {
                return Instant.MAX; // 3B: stale - keine verspätete Meldung für etwas Erledigtes
            }
            if ("erinnerung".equals(anlass) && alarm.gesehenVon() != null) {
                return Instant.MAX; // 3B: Erinnerungen enden bei "Gesehen"
            }
        }

        UUID tenantId = TenantContext.get();
        UUID anlageId = ueberwachung.anlageDesAlarmBezugs(alarm.bezugKennung());
        if (ruhezeitRepo.istStumm(tenantId, alarm.ueberwachungId(), alarm.standortId(), anlageId, jetzt)) {
            return Instant.MAX;
        }

        // B4: ohne eigene Zeile gilt die Vorgabe - genau die, die die Fläche für diesen Fall zeigt.
        RuhezeitRepository.RuhezeitPerson person = ruhezeitRepo.fuerVersand(tenantId, empfaengerSub).orElse(VORGABE);
        Instant ende = spaeteresEnde(person, alarm, jetzt);
        if (ende == null) {
            return jetzt; // keine Ruhezeit aktiv
        }
        boolean dringend = "dringend".equals(alarm.schwere());
        if (dringend && person.dringendDurch()) {
            return jetzt; // Entscheid 4A: durchbricht auf JEDEM Weg gleich, nicht nur Push
        }
        return ende;
    }

    private Instant spaeteresEnde(RuhezeitRepository.RuhezeitPerson person, AlarmZeile alarm, Instant jetzt) {
        Instant personEnde = RuhezeitFenster.endeFallsAktiv(person.regeln(), zone(person.zeitzone()), jetzt)
                .orElse(null);
        Instant regelEnde = null;
        Optional<UeberwachungZeile> regel = ueberwachung.einzelneRegel(alarm.ueberwachungId());
        if (regel.isPresent() && regel.get().ruhezeit() != null) {
            ZoneId zone = zone(ueberwachung.standortZeitzone(regel.get().standortId()));
            regelEnde = RuhezeitFenster.endeFallsAktiv(regel.get().ruhezeit(), zone, jetzt).orElse(null);
        }
        if (personEnde == null) {
            return regelEnde;
        }
        if (regelEnde == null) {
            return personEnde;
        }
        return personEnde.isAfter(regelEnde) ? personEnde : regelEnde;
    }

    private static ZoneId zone(String zeitzone) {
        return zeitzone == null ? STANDARD_ZEITZONE : ZoneId.of(zeitzone);
    }

    private static JsonNode vorgabeRegeln() {
        try {
            return new ObjectMapper().readTree(RuhezeitService.VORGABE_REGELN_JSON);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
