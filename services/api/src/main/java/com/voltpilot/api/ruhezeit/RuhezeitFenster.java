package com.voltpilot.api.ruhezeit;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.Optional;

/**
 * Reine Zeitrechnung für Ruhezeit-Fenster (Alerting Scheibe 3, Konzept §6.4): wiederkehrend je
 * Werktag ({@code Mo-Fr}) oder Wochenende ({@code Sa+So}), in EINER Zeitzone. Dieselbe JSON-Form gilt
 * sowohl für die Ruhezeit einer Person als auch für die optionale Ruhezeit einer Regel (eigene
 * Festlegung, kein Vorbild im Konzept-Text - siehe {@code V20261016100000}):
 *
 * <pre>{@code
 * {"werktags": {"von": "22:00", "bis": "07:00"}, "wochenende": "ganz"}
 * }</pre>
 *
 * {@code wochenende} ist entweder das Wort {@code "ganz"} (der GESAMTE Samstag und Sonntag) oder ein
 * {@code {"von","bis"}}-Objekt wie {@code werktags}; beide Felder sind optional - ein fehlendes Feld
 * kennt für seine Tage keine Ruhezeit. {@code von > bis} überspannt Mitternacht.
 *
 * <p>Kein Zustand, keine Datenbank - kein Geheimnis dieser Klasse hängt von der Außenwelt ab außer
 * der übergebenen Uhrzeit, darum ohne Testcontainers prüfbar.
 */
public final class RuhezeitFenster {

    private RuhezeitFenster() {
    }

    /**
     * {@code Optional.empty()}, wenn {@code jetzt} in KEINEM Fenster liegt; sonst der Zeitpunkt, an
     * dem das gerade geltende Fenster endet.
     */
    public static Optional<Instant> endeFallsAktiv(JsonNode fenster, ZoneId zeitzone, Instant jetzt) {
        if (fenster == null || fenster.isNull() || fenster.isMissingNode()) {
            return Optional.empty();
        }
        ZonedDateTime lokal = jetzt.atZone(zeitzone);
        // Ein Fenster kann vor "heute" begonnen haben und erst jetzt enden: eine Mitternacht-
        // Überspannung reicht einen Tag zurück, das (seit B6) bis in den Montagmorgen verlängerte
        // "wochenende: ganz" reicht von Montag aus gesehen bis zum Samstag zurück - darum beide
        // Vortage als möglichen Start prüfen.
        for (int tagVersatz : new int[] {-2, -1, 0}) {
            ZonedDateTime tagStart = lokal.toLocalDate().plusDays(tagVersatz).atStartOfDay(zeitzone);
            Optional<ZonedDateTime[]> fensterDesTages = fensterFuerTag(fenster, tagStart);
            if (fensterDesTages.isEmpty()) {
                continue;
            }
            ZonedDateTime start = fensterDesTages.get()[0];
            ZonedDateTime ende = fensterDesTages.get()[1];
            if (!lokal.isBefore(start) && lokal.isBefore(ende)) {
                return Optional.of(ende.toInstant());
            }
        }
        return Optional.empty();
    }

    /** Das Fenster, das an diesem Kalendertag (00:00 lokal) beginnt - leer, wenn dieser Tag keines hat. */
    private static Optional<ZonedDateTime[]> fensterFuerTag(JsonNode fenster, ZonedDateTime tagStart) {
        DayOfWeek tag = tagStart.getDayOfWeek();
        boolean samstag = tag == DayOfWeek.SATURDAY;
        boolean wochenendtag = samstag || tag == DayOfWeek.SUNDAY;
        if (wochenendtag) {
            JsonNode wochenende = fenster.path("wochenende");
            if (wochenende.isMissingNode() || wochenende.isNull()) {
                return Optional.empty();
            }
            if (wochenende.isTextual() && "ganz".equals(wochenende.asText())) {
                // NUR der Samstag trägt das zweitägige Fenster - der Sonntag würde sonst ein
                // zweites, überlappendes Fenster [So 00:00, Mo 00:00) erzeugen.
                if (!samstag) {
                    return Optional.empty();
                }
                // B6: ohne Verlängerung endete "ganz" Montag 00:00, während die werktägliche
                // Nachtruhe erst um 22:00 wieder beginnt - eine Lücke Montag 0 bis 7 Uhr. Das
                // Wochenend-Fenster reicht deshalb bis zum Ende der werktäglichen Morgen-Ruhe,
                // wenn eine konfiguriert ist; sonst bleibt es bei Montag 00:00.
                ZonedDateTime montag = tagStart.plusDays(2);
                LocalTime werktagsBis = zeit(fenster.path("werktags").path("bis"));
                ZonedDateTime ende = werktagsBis != null ? montag.with(werktagsBis) : montag;
                return Optional.of(new ZonedDateTime[] {tagStart, ende});
            }
            return vonBis(wochenende, tagStart);
        }
        return vonBis(fenster.path("werktags"), tagStart);
    }

    private static Optional<ZonedDateTime[]> vonBis(JsonNode spec, ZonedDateTime tagStart) {
        if (spec == null || spec.isMissingNode() || spec.isNull()) {
            return Optional.empty();
        }
        LocalTime von = zeit(spec.path("von"));
        LocalTime bis = zeit(spec.path("bis"));
        if (von == null || bis == null) {
            return Optional.empty();
        }
        ZonedDateTime start = tagStart.with(von);
        ZonedDateTime ende = tagStart.with(bis);
        if (!bis.isAfter(von)) {
            // "22:00 bis 07:00" überspannt Mitternacht - das Ende liegt am Folgetag.
            ende = ende.plusDays(1);
        }
        return Optional.of(new ZonedDateTime[] {start, ende});
    }

    private static LocalTime zeit(JsonNode node) {
        if (node == null || !node.isTextual()) {
            return null;
        }
        try {
            return LocalTime.parse(node.asText());
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
