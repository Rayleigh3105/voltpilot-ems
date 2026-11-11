package com.voltpilot.api.geraete;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * 409 für „Endgültig löschen": entweder {@code box_hat_daten} mit der LISTE der Datenarten (eine
 * Ablehnung ohne Liste ist eine Sackgasse - dasselbe Prinzip wie {@code BelegeImWeg}) oder
 * {@code nicht_ausgebaut} (Spec Punkt 1: eine nicht ausgebaute Box zuerst ausbauen). Nichts wurde
 * geändert; die Transaktion von {@link BoxEndgueltigLoeschenService} rollt zurück.
 */
public final class BoxEndgueltigAbgelehnt extends ResponseStatusException {

    private final String code;
    private final List<String> daten;

    private BoxEndgueltigAbgelehnt(String code, List<String> daten) {
        super(HttpStatus.CONFLICT, code + (daten.isEmpty() ? "" : ": " + daten));
        this.code = code;
        this.daten = daten;
    }

    public static BoxEndgueltigAbgelehnt hatDaten(List<String> daten) {
        return new BoxEndgueltigAbgelehnt("box_hat_daten", daten);
    }

    public static BoxEndgueltigAbgelehnt nichtAusgebaut() {
        return new BoxEndgueltigAbgelehnt("nicht_ausgebaut", List.of());
    }

    public Map<String, Object> koerper() {
        return Map.of("code", code, "daten", daten);
    }
}
