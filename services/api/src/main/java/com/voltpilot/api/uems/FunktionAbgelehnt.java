package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.FunktionDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Funktions-Schnittstelle (UEMS AP-01 IP-3). Wenn sie fliegt, ist nichts geschrieben.
 *
 * <p>Der geschlossene Satz: {@code anfrage_ungueltig} (400), {@code nicht_gefunden} (404 — eine fremde Anlage
 * und ein fremder Standort sind nie 403) und die Gründe des Vertrags {@link FunktionZustandAbleitung.Grund},
 * die ein Übergang von „Steuern &amp; Optimieren“ oder das Einrichten von „Messen &amp; Auswerten“ (AP-01 IP-9a)
 * nennen kann (409, Satz aus dem Vertrag). Bei
 * {@code pruefliste_offen} tragen {@code fehlt} und {@code wege} die roten Zeilen der Prüfliste, die IN
 * derselben Transaktion erneut gelaufen ist (R1/R2).
 */
public final class FunktionAbgelehnt extends RuntimeException {

    public static final String ANFRAGE_UNGUELTIG = "anfrage_ungueltig";
    public static final String NICHT_GEFUNDEN = "nicht_gefunden";

    /**
     * Die Gründe des Vertrags, die ein Übergang von „Steuern &amp; Optimieren“ nennt — und die zwei, mit denen das
     * Einrichten von „Messen &amp; Auswerten“ abgelehnt wird (AP-01 IP-9a).
     */
    public static final List<FunktionZustandAbleitung.Grund> GRUENDE = List.of(
            FunktionZustandAbleitung.Grund.NICHT_AUFGENOMMEN,
            FunktionZustandAbleitung.Grund.PRUEFLISTE_OFFEN,
            FunktionZustandAbleitung.Grund.NOCH_NICHT_GESTARTET,
            FunktionZustandAbleitung.Grund.LAEUFT_BEREITS,
            FunktionZustandAbleitung.Grund.IST_ANGEHALTEN,
            FunktionZustandAbleitung.Grund.BEREITS_ANGEHALTEN,
            FunktionZustandAbleitung.Grund.BEENDET,
            FunktionZustandAbleitung.Grund.BEREITS_ANGELEGT,
            FunktionZustandAbleitung.Grund.STANDORT_ARCHIVIERT);

    /** Alle Codes, die die Schnittstelle je antwortet. */
    public static final List<String> CODES;

    static {
        List<String> codes = new ArrayList<>(List.of(ANFRAGE_UNGUELTIG, NICHT_GEFUNDEN));
        GRUENDE.forEach(g -> codes.add(g.code()));
        CODES = List.copyOf(codes);
    }

    private final int status;
    private final String code;
    private final List<String> fehlt;
    private final List<FunktionDto.Weg> wege;

    private FunktionAbgelehnt(int status, String code, String satz, List<String> fehlt, List<FunktionDto.Weg> wege) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fehlt = List.copyOf(fehlt);
        this.wege = List.copyOf(wege);
    }

    /** Eine Anfrage, die keine erlaubte Aktion nennt. */
    public static FunktionAbgelehnt anfrage(String satz) {
        return new FunktionAbgelehnt(400, ANFRAGE_UNGUELTIG, satz, List.of(), List.of());
    }

    /** Eine Anlage oder ein Standort, den es im Kundenbereich nicht gibt. */
    public static FunktionAbgelehnt nichtGefunden(String satz) {
        return new FunktionAbgelehnt(404, NICHT_GEFUNDEN, satz, List.of(), List.of());
    }

    /**
     * Ein Übergang, den der Vertrag ablehnt — Code und Satz sind die des Vertrags; {@code fehlt} ist die Liste,
     * aus der er „es fehlt: …“ gebildet hat, {@code wege} je roter Zeile, was zu tun ist.
     */
    public static FunktionAbgelehnt uebergang(FunktionZustandAbleitung.UebergangErgebnis u, List<String> fehlt,
            List<FunktionDto.Weg> wege) {
        if (u.erlaubt() || !GRUENDE.contains(u.grund())) {
            throw new IllegalArgumentException("kein Ablehnungsgrund der Funktions-Schnittstelle: " + u.grund());
        }
        boolean offen = u.grund() == FunktionZustandAbleitung.Grund.PRUEFLISTE_OFFEN;
        return new FunktionAbgelehnt(409, u.grund().code(), u.text(), offen ? fehlt : List.of(),
                offen ? wege : List.of());
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    /** {@code {code, message, fehlt, wege}} — die Form jeder Ablehnung. */
    public Map<String, Object> body() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", getMessage());
        body.put("fehlt", fehlt);
        body.put("wege", wege);
        return body;
    }
}
