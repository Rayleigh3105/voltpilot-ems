package com.voltpilot.api.web;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import com.voltpilot.api.repo.PreisfassungRepository;

/**
 * „Ab wann?“ einer Preisänderung (vp-tarif-ab-tag): das Feld {@code gueltigAb}
 * der Schreibwege für Tarif, Preisblatt und Einspeisevergütung.
 *
 * <ul>
 *   <li>fehlt / {@code null}: ab heute (Europe/Berlin) - eine Änderung ohne
 *       Tag schreibt nie die Vergangenheit um;</li>
 *   <li>{@code "YYYY-MM-DD"}: ab diesem Tag bis heute, nie in der Zukunft (die
 *       heutige Fassung ist die, die Fahrplan und Box lesen);</li>
 *   <li>{@code "beginn"}: von Anfang an - die Angabe war schon immer falsch.</li>
 * </ul>
 */
public final class PreisGueltigAb {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private PreisGueltigAb() {
    }

    /**
     * Der geprüfte Wert für {@link PreisfassungRepository#abSetzen}: {@code null}
     * (heute), ein ISO-Tag oder {@link PreisfassungRepository#BEGINN}.
     *
     * @throws ResponseStatusException 400 bei einem ungültigen oder künftigen Tag
     */
    public static String pruefen(Object raw) {
        if (raw == null) {
            return null;
        }
        String text = raw.toString().trim();
        if (text.isEmpty()) {
            return null;
        }
        if (PreisfassungRepository.BEGINN.equals(text)) {
            return PreisfassungRepository.BEGINN;
        }
        LocalDate tag;
        try {
            tag = LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ab wann gilt die Änderung? Bitte einen Tag (JJJJ-MM-TT) oder \"beginn\" angeben.");
        }
        LocalDate heute = LocalDate.now(BERLIN);
        if (tag.isAfter(heute)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Eine Preisänderung gilt ab heute oder einem Tag davor, nicht ab dem "
                            + tag.format(DateTimeFormatter.ofPattern("dd.MM.yyyy"))
                            + ". Tragen Sie einen künftigen Wechsel bitte an seinem ersten Tag ein.");
        }
        return tag.toString();
    }
}
