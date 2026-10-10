package com.voltpilot.api.uems;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Benannter 409 am Box-Lebenszyklus, auch ohne Spring-Boot-Fehlerweiterleitung lesbar. */
public final class BoxKonflikt extends ResponseStatusException {
    private final String grund;
    private final String satz;

    public BoxKonflikt(String grund, String satz) {
        super(HttpStatus.CONFLICT, grund + ": " + satz);
        this.grund = grund;
        this.satz = satz;
    }

    public Map<String, String> koerper() {
        return Map.of("grund", grund, "satz", satz);
    }
}
