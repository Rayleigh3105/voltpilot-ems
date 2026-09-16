package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.RechteAbleitung.Grund;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine Änderung an einer Zuweisung, die der Vertrag ablehnt (UEMS AP-03 IP-9, §4.7, §5.9) — 409
 * {@code eigene_zuweisung}, 409 {@code letzter_kundenadministrator}, 422 {@code standort_fehlt}.
 *
 * <p>Der Grund kommt aus {@link com.voltpilot.api.uems.RechteAbleitung#zuweisungAendern}, samt HTTP-Kennzahl und
 * Kundensatz; hier wird nichts entschieden und nichts formuliert. Wie {@link RechtFehlt} ist sie bewusst keine
 * {@code ResponseStatusException}.
 */
public class ZugriffAbgelehnt extends RuntimeException {

    private final transient Grund grund;
    private final int http;

    public ZugriffAbgelehnt(int http, Grund grund, String text) {
        super(text == null ? grund.code() : text);
        this.http = http;
        this.grund = grund;
    }

    public int http() {
        return http;
    }

    public Grund grund() {
        return grund;
    }

    public Map<String, Object> koerper() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", grund.code());
        body.put("message", getMessage());
        return body;
    }
}
