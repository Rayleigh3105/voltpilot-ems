package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.ocpp.OcppRepository;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.OcppDto;
import com.voltpilot.api.web.dto.VerbraucherDto;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der {@code ladepunkt}-Leser (Konzept „Ein Ort fürs Laden" e1, Scheibe 4, §4/§9, E6 = A): die
 * Wertequelle „Ladepunkt" der Überwachung - zwei Meldungen ab Werk EINGESCHALTET
 * ({@code wallbox_meldet_sich_nicht}, {@code ziel_wird_knapp}) und zwei wählbare
 * ({@code auto_angesteckt}, {@code ladung_fertig}). Bezug: die Anlage, wie {@code box.erreichbar} -
 * mehrere Ladepunkte an einer Anlage fassen die einzelnen Feld-Methoden selbst zu EINEM Urteil
 * (der auffälligste Zustand gewinnt, dasselbe Vorbild wie {@code ErzeugerWerteLeser#zusammen}).
 *
 * <p>Liest GENAU die Flächen, die auch das Portal zeigt: {@link OcppRepository#stations} für den
 * Verbindungs- und Stecker-Zustand (wie {@code api.siteChargers}), {@link VerbraucherService#forSite}
 * für die Steuerart samt Ladeziel (wie {@code api.siteVerbraucher}) - nie eine eigene Abfrage.
 *
 * <p><b>{@code ziel_wird_knapp} ist eine bewusst EINFACHE Annäherung, keine Simulation</b>
 * (Konzept §9 "Offene Annahmen"): die volle Vorschau-Rechnung des Portals (`ladeVorschau.ts`,
 * PV/Preis/Speicher/Vorrang) hat auf dem Server keine Entsprechung und würde eine eigene, fehleranfällige
 * zweite Zahlenwelt neben der Vorschau bauen. Diese Meldung prüft stattdessen nur: ein Ladeziel mit
 * Uhrzeit ist gesetzt, ein Auto steckt, es lädt gerade NICHT (Stecker-Zustand ungleich "Charging"), und
 * die Frist liegt höchstens {@link #KNAPP_FENSTER} entfernt - "die Zeit wird knapp, und gerade fließt
 * nichts dorthin", nie eine geschätzte Restmenge. Das hält die Meldung ohne Doppel-Buchführung der
 * Energiebilanz und ohne eigene kWh-Schätzung aus einer laufenden Sitzung (die auch
 * {@code OcppTransactionEconomicsService} bewusst vermeidet - "nie aus einer laufenden Sitzung").
 */
@Component
public class LadepunktWerteLeser implements WerteLeser {

    static final String FELD_WALLBOX_MELDET_SICH_NICHT = "wallbox_meldet_sich_nicht";
    static final String FELD_ZIEL_WIRD_KNAPP = "ziel_wird_knapp";
    static final String FELD_AUTO_ANGESTECKT = "auto_angesteckt";
    static final String FELD_LADUNG_FERTIG = "ladung_fertig";

    public static final String ERREICHBAR = "erreichbar";
    public static final String NICHT_ERREICHBAR = "nicht_erreichbar";
    public static final String REICHT = "reicht";
    public static final String KNAPP = "knapp";
    public static final String ANGESTECKT = "angesteckt";
    public static final String NICHT_ANGESTECKT = "nicht_angesteckt";
    public static final String LAEDT = "laedt";
    public static final String FERTIG = "fertig";

    /** Nur innerhalb dieses Fensters vor der Frist gilt "knapp" (§9: keine Vorhersage lange vorher). */
    static final java.time.Duration KNAPP_FENSTER = java.time.Duration.ofHours(2);

    /** Stecker-Zustände, die ein angestecktes Auto bedeuten (OCPP `ocpp_connector_state.status`). */
    private static final List<String> ANGESTECKT_ZUSTAENDE = List.of(
            "Preparing", "Charging", "SuspendedEV", "SuspendedEVSE", "Finishing");

    private final OcppRepository ocpp;
    private final VerbraucherService verbraucher;

    public LadepunktWerteLeser(OcppRepository ocpp, VerbraucherService verbraucher) {
        this.ocpp = ocpp;
        this.verbraucher = verbraucher;
    }

    /** Hat die Anlage mindestens eine Ladesäule (Grundlage der Aussaat ab Werk)? */
    public boolean hatLadepunkt(UUID anlageId) {
        return !ocpp.stations(anlageId).isEmpty();
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        String feld = eintrag.leser().feld();
        List<OcppDto.Station> stationen = ocpp.stations(bezug.id());
        if (stationen.isEmpty()) {
            return Lesung.unbekannt();
        }
        return switch (feld) {
            case FELD_WALLBOX_MELDET_SICH_NICHT -> wallboxMeldetSichNicht(stationen, jetzt);
            case FELD_AUTO_ANGESTECKT -> autoAngesteckt(stationen);
            case FELD_LADUNG_FERTIG -> ladungFertig(stationen);
            case FELD_ZIEL_WIRD_KNAPP -> zielWirdKnapp(bezug.id(), stationen, jetzt);
            default -> throw new IllegalArgumentException("LadepunktWerteLeser: unbekanntes Feld '" + feld + "'");
        };
    }

    /** Mindestens eine Säule ohne frisches Lebenszeichen - dieselbe Toleranz wie {@code box.erreichbar}. */
    private Lesung wallboxMeldetSichNicht(List<OcppDto.Station> stationen, Instant jetzt) {
        Instant schlechtester = null;
        for (OcppDto.Station s : stationen) {
            if (s.lastSeen() == null) {
                return Lesung.unbekannt(); // wartet auf die erste Meldung - nicht "nicht erreichbar"
            }
            if (schlechtester == null || s.lastSeen().isBefore(schlechtester)) {
                schlechtester = s.lastSeen();
            }
        }
        boolean erreichbar = jetzt.getEpochSecond() - schlechtester.getEpochSecond()
                <= com.voltpilot.api.uems.ZustandAbleitung.TOLERANZ_MINDESTENS_S;
        return Lesung.zustand(erreichbar ? ERREICHBAR : NICHT_ERREICHBAR, schlechtester);
    }

    private Lesung autoAngesteckt(List<OcppDto.Station> stationen) {
        boolean angesteckt = stationen.stream().flatMap(s -> s.connectors().stream())
                .anyMatch(c -> ANGESTECKT_ZUSTAENDE.contains(c.status()));
        return Lesung.zustand(angesteckt ? ANGESTECKT : NICHT_ANGESTECKT, null);
    }

    /** "Finishing" (OCPP: fertig geladen, Auto steckt noch) schlägt "Charging" schlägt sonst nicht angesteckt. */
    private Lesung ladungFertig(List<OcppDto.Station> stationen) {
        List<String> zustaende = stationen.stream().flatMap(s -> s.connectors().stream())
                .map(OcppDto.ConnectorState::status).toList();
        if (zustaende.contains("Finishing")) {
            return Lesung.zustand(FERTIG, null);
        }
        if (zustaende.stream().anyMatch(ANGESTECKT_ZUSTAENDE::contains)) {
            return Lesung.zustand(LAEDT, null);
        }
        return Lesung.zustand(NICHT_ANGESTECKT, null);
    }

    private Lesung zielWirdKnapp(UUID anlageId, List<OcppDto.Station> stationen, Instant jetzt) {
        VerbraucherDto v = verbraucher.forSite(anlageId);
        boolean ladendesAutoOhneFrist = false;
        for (VerbraucherDto.Eintrag e : v.verbraucher()) {
            if (e.chargePointId() == null || e.steuerart() == null
                    || !SteuerartProjektion.ZIEL_BIS_UHRZEIT.equals(e.steuerart().ziel())
                    || e.steuerart().zielFenster() == null || e.steuerart().zielFenster().bis() == null) {
                continue;
            }
            boolean steckt = stationen.stream().filter(s -> e.chargePointId().equals(s.chargePointId()))
                    .flatMap(s -> s.connectors().stream())
                    .anyMatch(c -> ANGESTECKT_ZUSTAENDE.contains(c.status()));
            if (!steckt) {
                continue;
            }
            boolean laedt = stationen.stream().filter(s -> e.chargePointId().equals(s.chargePointId()))
                    .flatMap(s -> s.connectors().stream())
                    .anyMatch(c -> "Charging".equals(c.status()));
            ladendesAutoOhneFrist = true;
            if (laedt) {
                continue; // es fließt etwas Richtung Ziel - nicht "knapp"
            }
            Instant frist = naechsteFrist(e.steuerart().zielFenster().bis(), jetzt);
            if (frist != null && !jetzt.isAfter(frist) && !frist.isAfter(jetzt.plus(KNAPP_FENSTER))) {
                return Lesung.zustand(KNAPP, jetzt);
            }
        }
        return ladendesAutoOhneFrist ? Lesung.zustand(REICHT, jetzt) : Lesung.unbekannt();
    }

    /** Die nächste Uhrzeit `hhmm` ab {@code jetzt} (heute, sonst morgen) - wie `naechsteUhrzeit` im Portal. */
    private static Instant naechsteFrist(String hhmm, Instant jetzt) {
        LocalTime zeit;
        try {
            zeit = LocalTime.parse(hhmm);
        } catch (DateTimeParseException ex) {
            return null;
        }
        ZoneId zone = HistoryRange.ZONE;
        ZonedDateTime heute = jetzt.atZone(zone).toLocalDate().atTime(zeit).atZone(zone);
        return (heute.toInstant().isBefore(jetzt) ? heute.plusDays(1) : heute).toInstant();
    }
}
