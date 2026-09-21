package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Routen der Gemeinsamen Steuerung (UEMS AP-15 IP-5). Wenn sie fliegt, ist nichts geschrieben.
 *
 * <p>Der geschlossene Satz: {@code anfrage_ungueltig} (400 — auch ein Mandant oder eine Anlage im Körper),
 * {@code nicht_gefunden} (404 — eine fremde Anlage ist nie 403), die neun Wörter des Ablehnungs-Vokabulars (409, das
 * ERSTE Wort in Vokabular-Reihenfolge; {@code fehlt} trägt alle) und die Übergangs-Gründe unten (409).
 */
public final class GemeinsameSteuerungAbgelehnt extends RuntimeException {

    public static final String ANFRAGE_UNGUELTIG = "anfrage_ungueltig";
    public static final String NICHT_GEFUNDEN = "nicht_gefunden";
    /** Anhalten, fortsetzen, auflösen, scharfschalten oder bestätigen ohne Gemeinsame Steuerung. */
    public static final String NICHT_EINGERICHTET = "nicht_eingerichtet";
    /** Anhalten verlangt {@code anteile_aktiv}. */
    public static final String NICHT_AKTIV = "nicht_aktiv";
    /** Fortsetzen verlangt {@code angehalten}. */
    public static final String NICHT_ANGEHALTEN = "nicht_angehalten";
    /** Fortsetzen durch ein Kundenkonto, nachdem der Betreiber angehalten hat (W9/I5) — nur der Betreiber setzt fort. */
    public static final String VOM_BETREIBER_ANGEHALTEN = "vom_betreiber_angehalten";
    /** Scharfschalten einer Anlage, deren Anteile schon aktiv sind. */
    public static final String BEREITS_AKTIV = "bereits_aktiv";
    /** Ändern oder Auflösen, während die Anteile aktiv sind: erst anhalten (T6). */
    public static final String ERST_ANHALTEN = "erst_anhalten";
    /** Auflösen nach einem Scharfschalten: die Anteile sind an den Boxen in Kraft — nur im Zweischritt (IP-7). */
    public static final String ANTEILE_IN_KRAFT = "anteile_in_kraft";
    /** Bestätigen einer Box, die kein wirksames Mitglied ist. */
    public static final String KEIN_MITGLIED = "kein_mitglied";
    /** Bestätigen eines Mitglieds, das schon bestätigt ist. */
    public static final String BEREITS_BESTAETIGT = "bereits_bestaetigt";
    /** Freigabe des Vorbehalts ohne offenen Vorschlag zum Senken (IP-13) — oder er passt nicht mehr. */
    public static final String KEIN_VORSCHLAG = "kein_vorschlag";

    /** Die Übergangs-Gründe (409) in ihrer Vertrags-Reihenfolge. */
    public static final List<String> UEBERGANG = List.of(NICHT_EINGERICHTET, NICHT_AKTIV, NICHT_ANGEHALTEN,
            VOM_BETREIBER_ANGEHALTEN, BEREITS_AKTIV, ERST_ANHALTEN, ANTEILE_IN_KRAFT, KEIN_MITGLIED, BEREITS_BESTAETIGT,
            KEIN_VORSCHLAG);

    private final int status;
    private final String code;
    private final List<GemeinsameSteuerungDto.Befund> fehlt;

    private GemeinsameSteuerungAbgelehnt(int status, String code, String satz, List<GemeinsameSteuerungDto.Befund> fehlt) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fehlt = List.copyOf(fehlt);
    }

    public static GemeinsameSteuerungAbgelehnt anfrage(String satz) {
        return new GemeinsameSteuerungAbgelehnt(400, ANFRAGE_UNGUELTIG, satz, List.of());
    }

    public static GemeinsameSteuerungAbgelehnt nichtGefunden() {
        return new GemeinsameSteuerungAbgelehnt(404, NICHT_GEFUNDEN, "Nicht gefunden.", List.of());
    }

    /** Ein Übergang, den der Zustand nicht erlaubt. */
    public static GemeinsameSteuerungAbgelehnt uebergang(String code, String satz) {
        if (!UEBERGANG.contains(code)) {
            throw new IllegalArgumentException("kein Übergangs-Grund: " + code);
        }
        return new GemeinsameSteuerungAbgelehnt(409, code, satz, List.of());
    }

    /** Eine Bedingung aus dem Ablehnungs-Vokabular: Code = das erste Wort, {@code fehlt} = alle Befunde. */
    public static GemeinsameSteuerungAbgelehnt bedingung(Ablehnung erstes, List<GemeinsameSteuerungDto.Befund> fehlt) {
        return new GemeinsameSteuerungAbgelehnt(409, erstes.code(), "Die Bedingung „" + erstes.code()
                + "“ ist nicht erfüllt.", fehlt);
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    /** {@code {code, message, fehlt}} — {@code fehlt} nur bei einem Wort des Ablehnungs-Vokabulars. */
    public Map<String, Object> body() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", getMessage());
        if (!fehlt.isEmpty()) {
            body.put("fehlt", fehlt);
        }
        return body;
    }
}
