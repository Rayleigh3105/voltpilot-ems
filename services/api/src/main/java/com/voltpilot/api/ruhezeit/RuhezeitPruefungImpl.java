package com.voltpilot.api.ruhezeit;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.ueberwachung.UeberwachungRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.RuhezeitPruefung;
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
 * (verspätete) Meldung mehr (Entscheid 3B); (2) eine aktive Stummschaltung unterdrückt endgültig;
 * (3) eine aktive Ruhezeit (Person ODER Regel, das SPÄTERE Ende gilt) verschiebt - außer Dringend
 * über Push, wenn die Person "Dringendes trotzdem melden" nicht abgeschaltet hat (Entscheid 8A).
 */
@Component
public class RuhezeitPruefungImpl implements RuhezeitPruefung {

    private static final ZoneId STANDARD_ZEITZONE = ZoneId.of("Europe/Berlin");

    private final UeberwachungRepository ueberwachung;
    private final RuhezeitRepository ruhezeitRepo;

    public RuhezeitPruefungImpl(UeberwachungRepository ueberwachung, RuhezeitRepository ruhezeitRepo) {
        this.ueberwachung = ueberwachung;
        this.ruhezeitRepo = ruhezeitRepo;
    }

    @Override
    public Instant wannSenden(UUID alarmId, String empfaengerSub, String weg, String anlass, Instant jetzt) {
        if (!"ausgeloest".equals(anlass) && !"erinnerung".equals(anlass)) {
            return jetzt; // wieder_normal/zusammenfassung/bestaetigung: nie gehalten
        }
        AlarmZeile alarm = ueberwachung.alarm(alarmId).orElse(null);
        if (alarm == null) {
            return jetzt; // schon weg (Löschlauf einer späteren Scheibe) - nichts zu halten
        }
        if ("erledigt".equals(alarm.zustand())) {
            return Instant.MAX; // 3B: stale - keine verspätete Meldung für etwas Erledigtes
        }
        if ("erinnerung".equals(anlass) && alarm.gesehenVon() != null) {
            return Instant.MAX; // 3B: Erinnerungen enden bei "Gesehen"
        }

        UUID tenantId = TenantContext.get();
        UUID anlageId = ueberwachung.anlageDesAlarmBezugs(alarm.bezugKennung());
        if (ruhezeitRepo.istStumm(tenantId, alarm.ueberwachungId(), alarm.standortId(), anlageId, jetzt)) {
            return Instant.MAX;
        }

        RuhezeitRepository.RuhezeitPerson person = ruhezeitRepo.fuerVersand(tenantId, empfaengerSub).orElse(null);
        Instant ende = spaeteresEnde(person, alarm, jetzt);
        if (ende == null) {
            return jetzt; // keine Ruhezeit aktiv
        }
        boolean dringend = "dringend".equals(alarm.schwere());
        boolean dringendDurchPush = person == null || person.dringendDurch();
        if (dringend && !("webpush".equals(weg) && !dringendDurchPush)) {
            return jetzt; // Dringend durchbricht (Entscheid 8A) - außer Push mit abgeschaltetem Schalter
        }
        return ende;
    }

    private Instant spaeteresEnde(RuhezeitRepository.RuhezeitPerson person, AlarmZeile alarm, Instant jetzt) {
        Instant personEnde = null;
        if (person != null) {
            ZoneId zone = zone(person.zeitzone());
            personEnde = RuhezeitFenster.endeFallsAktiv(person.regeln(), zone, jetzt).orElse(null);
        }
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
}
