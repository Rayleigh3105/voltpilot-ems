package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
import java.time.Duration;
import java.time.Instant;
import org.springframework.stereotype.Component;

/**
 * Der {@code direktvermarktung}-Leser (Konzept vp-direktvermarktung-konzept d2 §5.7 "Alarme", Vertrag
 * {@code docs/contracts/v2/direktvermarktung-zustellung.md} §6): liest den Herzschlag-Spiegel
 * {@code direktvermarktung_stand} und den aktuellen Zugang - nie eine eigene Abfrage an die Box.
 *
 * <p><b>"Unbekannt hält"</b> (§5.7): meldet sich die Box nicht (kein Spiegel, oder älter als
 * {@link #SPIEGEL_FRISCH}), ist jede Lesung unbekannt - luox kann trotzdem verbunden sein, der Tunnel geht
 * nicht über die Cloud. Ein AKTIVER Alarm bleibt dann aktiv (die Sonderbehandlung in
 * {@code UeberwachungsService.werte}, wie beim Erzeuger-Leser); auslösen kann Unbekannt nie, und
 * {@code box.erreichbar} meldet die stumme Box ohnehin ({@code GATENDE_WERTARTEN} unterdrückt Folgealarme).
 *
 * <p>Die Fristen der Meldungen (15/60/5 Minuten, 30/7 Tage) setzen sich aus der Frische-Grenze des Lesers
 * und der {@code dauer_s} des Katalog-Eintrags zusammen - die Zahlen stehen dort, nie hier.
 */
@Component
public class DirektvermarktungWerteLeser implements WerteLeser {

    static final String FELD_VERBINDUNG = "verbindung";
    static final String FELD_ABFRAGE = "partner_abfrage";
    static final String FELD_GRENZE = "einspeisegrenze";
    static final String FELD_ZUGANG_30 = "zugang_frist_30";
    static final String FELD_ZUGANG_7 = "zugang_frist_7";

    /** Älter gemeldet als das = die Box sagt gerade nichts über den Anschluss ("Stand unbekannt seit …"). */
    static final Duration SPIEGEL_FRISCH = Duration.ofMinutes(10);
    /** Handshake-Frische der Lage-Tabelle (§5.4: Handshake älter als 3 Min. = tunnel_unten). */
    static final Duration HANDSHAKE_FRISCH = Duration.ofMinutes(3);
    /** Abfrage-Frische der Lage-Tabelle (§5.4: letzte Abfrage jünger als 15 Min. = verbunden). */
    static final Duration ABFRAGE_FRISCH = Duration.ofMinutes(15);
    /** Toleranz der Grenzüberschreitung (§5.6 "Einspeisung über Grenze plus Toleranz"): 5 % der
     * Referenzleistung, mindestens 500 W - luox nennt keine Zahl, darum eine erklärte Annahme. */
    static final double TOLERANZ_ANTEIL = 0.05;
    static final double TOLERANZ_MINDESTENS_W = 500;

    private final DirektvermarktungRepository repo;

    public DirektvermarktungWerteLeser(DirektvermarktungRepository repo) {
        this.repo = repo;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        Eintrag anschluss = repo.aktiverOhneEnde(bezug.id());
        if (anschluss == null || DirektvermarktungRepository.ENTWURF.equals(anschluss.zustand())) {
            return Lesung.unbekannt();
        }
        String feld = eintrag.leser().feld();
        if (FELD_ZUGANG_30.equals(feld) || FELD_ZUGANG_7.equals(feld)) {
            return zugangFrist(anschluss, FELD_ZUGANG_30.equals(feld) ? 30 : 7, jetzt);
        }
        Stand stand = repo.stand(bezug.id());
        if (stand == null || stand.gemeldetAm() == null
                || jetzt.minus(SPIEGEL_FRISCH).isAfter(stand.gemeldetAm())) {
            return Lesung.unbekannt(); // Stand unbekannt - hält, löst nie aus
        }
        return switch (feld) {
            case FELD_VERBINDUNG -> verbindung(stand, jetzt);
            case FELD_ABFRAGE -> abfrage(stand, jetzt);
            case FELD_GRENZE -> grenze(stand);
            default -> Lesung.unbekannt();
        };
    }

    /** verbunden/getrennt nach der Handshake-Frische; nie verbunden hat noch keinen Tunnel verloren. */
    private Lesung verbindung(Stand stand, Instant jetzt) {
        if (stand.handshakeAm() == null) {
            // baut_auf: der Tunnel kam noch nie - das meldet die Einrichtung, nicht dieser Alarm.
            return Lesung.unbekannt();
        }
        boolean frisch = !jetzt.minus(HANDSHAKE_FRISCH).isAfter(stand.handshakeAm());
        return Lesung.zustand(frisch ? "verbunden" : "getrennt", stand.gemeldetAm());
    }

    /** liest/liest_nicht nach der Abfrage-Frische - nur bei stehendem Tunnel; sonst meldet verbindung_weg. */
    private Lesung abfrage(Stand stand, Instant jetzt) {
        if (stand.handshakeAm() == null || jetzt.minus(HANDSHAKE_FRISCH).isAfter(stand.handshakeAm())) {
            return Lesung.unbekannt();
        }
        boolean frisch = stand.letzteAbfrageAm() != null
                && !jetzt.minus(ABFRAGE_FRISCH).isAfter(stand.letzteAbfrageAm());
        return Lesung.zustand(frisch ? "liest" : "liest_nicht", stand.gemeldetAm());
    }

    /** folgt/folgt_nicht gegen die wirksame Grenze; ohne aktive Vorgabe gibt es nichts zu folgen. */
    private Lesung grenze(Stand stand) {
        Integer pct = stand.vorgabePct();
        if (pct == null || pct >= 100) {
            return Lesung.zustand("folgt", stand.gemeldetAm());
        }
        if (stand.referenzW() == null || stand.einspeisungW() == null) {
            return Lesung.unbekannt(); // Unbekannt ist keine Null - ohne Messung kein Urteil
        }
        double grenzeW = stand.referenzW() * pct / 100.0;
        double toleranzW = Math.max(stand.referenzW() * TOLERANZ_ANTEIL, TOLERANZ_MINDESTENS_W);
        boolean folgt = stand.einspeisungW() <= grenzeW + toleranzW;
        return Lesung.zustand(folgt ? "folgt" : "folgt_nicht", stand.gemeldetAm());
    }

    /** gueltig/laeuft_ab mit dem Vorlauf in Tagen; ohne Zugang oder ohne Frist ist nichts zu melden. */
    private Lesung zugangFrist(Eintrag anschluss, int vorlaufTage, Instant jetzt) {
        ZugangZeile zugang = repo.aktuellerZugang(anschluss.id());
        if (zugang == null || zugang.gueltigBis() == null) {
            return Lesung.unbekannt();
        }
        boolean knapp = !jetzt.plus(Duration.ofDays(vorlaufTage)).isBefore(zugang.gueltigBis());
        return Lesung.zustand(knapp ? "laeuft_ab" : "gueltig", jetzt);
    }
}
