package com.voltpilot.api.fernwartung;

import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Geprueft;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungRepository.BoxStand;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungRepository.DienstStand;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungRepository.FensterStand;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Nimmt die Rückmeldung des Tunnel-Dienstes an und gibt sie dem Portal zur
 * Anzeige (Fenster-Schlüssel, Schritt 4; Entscheid K3 a des Kapitäns).
 *
 * <p><b>Nur Anzeige.</b> Dieser Dienst schreibt allein die Tabellen der
 * Rückmeldung. Er ändert weder Zugänge noch Fenster noch das Protokoll, und
 * {@link FernwartungService#soll} liest nichts von dem, was hier steht: Eine
 * falsche oder böswillige Meldung kann im Portal etwas Falsches anzeigen,
 * aber keinen Weg öffnen und keinen Schlüssel ausgeben lassen.
 *
 * <p><b>Ganz oder gar nicht.</b> Nennt eine Meldung eine Box oder ein
 * Fenster, das die API nicht kennt, wird sie als Ganzes abgewiesen: Sie
 * stammt dann nicht von einem Dienst, der diesen Soll-Stand umsetzt.
 */
@Service
public class FernwartungRueckmeldungService {

    private final FernwartungRueckmeldungRepository repo;
    private final Clock clock;

    @Autowired
    public FernwartungRueckmeldungService(FernwartungRueckmeldungRepository repo) {
        this(repo, Clock.systemUTC());
    }

    FernwartungRueckmeldungService(FernwartungRueckmeldungRepository repo, Clock clock) {
        this.repo = repo;
        this.clock = clock;
    }

    /**
     * Prüft und speichert eine Meldung. 400 = nicht die vereinbarte Form,
     * 422 = eine Box oder ein Fenster ist der API unbekannt; in beiden Fällen
     * bleibt der vorige Stand unverändert.
     */
    public void annehmen(String dienst, byte[] rumpf) {
        Instant jetzt = clock.instant();
        Geprueft meldung;
        try {
            meldung = FernwartungRueckmeldung.pruefe(FernwartungRueckmeldung.lies(rumpf), jetzt);
        } catch (FernwartungRueckmeldung.Ungueltig e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        Set<UUID> boxen = new HashSet<>();
        meldung.boxen().forEach(b -> boxen.add(b.id()));
        Set<UUID> fenster = new HashSet<>();
        meldung.fenster().forEach(f -> fenster.add(f.id()));
        unbekannt(boxen, repo.bekannteBoxen(boxen), "eine Box, die");
        unbekannt(fenster, repo.bekannteFenster(fenster), "ein Fenster, das");
        repo.speichern(dienst == null || dienst.isBlank() ? "unbekannt" : dienst, jetzt, meldung);
    }

    private static void unbekannt(Set<UUID> gemeldet, Set<UUID> bekannt, String was) {
        for (UUID id : gemeldet) {
            if (!bekannt.contains(id)) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Die Rückmeldung nennt " + was + " die API nicht kennt (" + id
                                + "). Nichts aus dieser Meldung wurde gespeichert.");
            }
        }
    }

    // ── Lesen, nur für die Routen des Portals ─────────────────────────────

    /** Die letzte Meldung je Dienstkonto, neueste zuerst. */
    public List<DienstStand> dienste() {
        return repo.dienste();
    }

    public Map<UUID, BoxStand> boxen() {
        return repo.boxen();
    }

    public Map<UUID, FensterStand> fenster(Collection<UUID> ids) {
        return repo.fenster(ids);
    }
}
