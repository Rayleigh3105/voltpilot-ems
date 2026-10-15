package com.voltpilot.api.ruhezeit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Ruhezeit" in der Einstellungsfläche "Meine Benachrichtigungen" (Alerting Scheibe 3, Konzept §6.4,
 * §6.8 Entwurf 4): wiederkehrend je Person, Vorgabe "werktags 22 bis 7 Uhr, am Wochenende ganz"
 * (§7 Scheibe 3). Validiert die Eingabe (gültige Zeiten, gültige Zeitzone) und wendet sie ohne
 * Rechte-Prüfung an - jede Person verwaltet NUR ihre eigene Ruhezeit (wie
 * {@code ZustellwegService}: Recht {@code konto.eigenes}, geprüft am Controller).
 */
@Service
public class RuhezeitService {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> ZEITZONEN = List.of("Europe/Berlin", "Europe/Vienna", "Europe/Zurich");

    /** Vorgabe nach §7 Scheibe 3: werktags 22 bis 7 Uhr, am Wochenende ganz, Dringend durchbricht per Push. */
    public static final String VORGABE_REGELN_JSON =
            "{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"},\"wochenende\":\"ganz\"}";

    private final RuhezeitRepository repo;

    public RuhezeitService(RuhezeitRepository repo) {
        this.repo = repo;
    }

    public Optional<RuhezeitRepository.RuhezeitPerson> eigene(String benutzerSub) {
        return repo.eigene(benutzerSub);
    }

    /**
     * @param regelnJson {@code {"werktags":{"von":"HH:mm","bis":"HH:mm"},"wochenende":"ganz"|{...}}}
     *                   - leer/{@code null} löscht die eigene Ruhezeit nicht, sondern bedeutet "keine"
     *                   (eine Person kann die Ruhezeit jederzeit auf "nie" stellen, indem sie beide
     *                   Felder weglässt: {@code {}}).
     */
    public void setzen(String benutzerSub, String regelnJson, String zeitzone, boolean dringendDurch) {
        JsonNode regeln = validiereRegeln(regelnJson);
        if (!ZEITZONEN.contains(zeitzone)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "unbekannte Zeitzone '" + zeitzone + "'");
        }
        repo.setzen(benutzerSub, regeln.toString(), zeitzone, dringendDurch);
    }

    /** Nur zur Validierung UND für eine Live-Vorschau im Blatt ("Ruhezeit ist jetzt aktiv bis …"). */
    public Optional<Instant> probeAktivBis(String regelnJson, String zeitzone, Instant jetzt) {
        JsonNode regeln = validiereRegeln(regelnJson);
        ZoneId zone = ZEITZONEN.contains(zeitzone) ? ZoneId.of(zeitzone) : ZoneId.of("Europe/Berlin");
        return RuhezeitFenster.endeFallsAktiv(regeln, zone, jetzt);
    }

    private static JsonNode validiereRegeln(String regelnJson) {
        JsonNode regeln;
        try {
            regeln = regelnJson == null || regelnJson.isBlank() ? JSON.createObjectNode() : JSON.readTree(regelnJson);
        } catch (Exception e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Ruhezeit: ungültiges JSON");
        }
        if (!regeln.isObject()) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Ruhezeit: muss ein Objekt sein");
        }
        validiereTeil(regeln.path("werktags"));
        JsonNode wochenende = regeln.path("wochenende");
        if (!wochenende.isMissingNode() && !wochenende.isNull()
                && !(wochenende.isTextual() && "ganz".equals(wochenende.asText()))) {
            validiereTeil(wochenende);
        }
        return regeln;
    }

    private static void validiereTeil(JsonNode teil) {
        if (teil.isMissingNode() || teil.isNull()) {
            return;
        }
        if (!teil.isObject() || !teil.has("von") || !teil.has("bis")) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Ruhezeit: 'von' und 'bis' fehlen");
        }
        zeit(teil.path("von"));
        zeit(teil.path("bis"));
    }

    private static LocalTime zeit(JsonNode node) {
        try {
            return LocalTime.parse(node.asText());
        } catch (Exception e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Ruhezeit: ungültige Uhrzeit '" + node.asText() + "'");
        }
    }
}
