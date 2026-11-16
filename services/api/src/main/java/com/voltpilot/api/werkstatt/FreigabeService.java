package com.voltpilot.api.werkstatt;

import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * Die Freigaben der Werkstatt als Verlauf (Werkstatt-Automatik V1, Entscheide
 * WI-4 A und WI-9 A): je Zeile, welche Fassungen mit welchen Prüfsummen und bis
 * wann. Seit 16.11.2026 legt sie die Regel „neueste Fassung“ selbst an
 * ({@link WerkstattRegel}); die Zeilen von Hand davor bleiben lesbar, wie sie
 * sind. Ein Formular zum Freigeben gibt es nicht mehr.
 */
@Service
public class FreigabeService {

    public static final String MANGO = "mango";

    /** Eine Freigabe mit ihrem Stand zu einem Zeitpunkt. */
    public record Stand(Freigabe freigabe, String zustand, String grund) {
    }

    private final FreigabeRepository repo;
    private Clock uhr = Clock.systemUTC();

    public FreigabeService(FreigabeRepository repo) {
        this.repo = repo;
    }

    /** Für Tests: eine andere Uhr. */
    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    /** Alle Freigaben, neueste zuerst. */
    public List<Stand> alle() {
        Instant jetzt = uhr.instant();
        return repo.alle().stream().map(f -> stand(f, jetzt)).toList();
    }

    /** {@code laufend}, {@code beendet} oder {@code abgelaufen}, mit Grund in Worten. */
    public static Stand stand(Freigabe f, Instant jetzt) {
        if (f.beendetAm() != null) {
            return new Stand(f, "beendet", "Freigabe " + f.kennung() + " ist beendet.");
        }
        if (!jetzt.isBefore(f.gueltigBis())) {
            return new Stand(f, "abgelaufen", "Freigabe " + f.kennung() + " ist abgelaufen.");
        }
        return new Stand(f, "laufend", null);
    }
}
