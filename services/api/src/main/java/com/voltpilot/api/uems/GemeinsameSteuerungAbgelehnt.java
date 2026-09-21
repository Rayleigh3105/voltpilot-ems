package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.web.dto.GemeinsameSteuerungEinrichtenDto;
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
    /**
     * Ein erklärter Vorbehalt der Bezugsseite UNTER dem, den eine Messung trägt (B4): senken ist ein Vorschlag mit
     * Freigabe des Betreibers (IP-13), nie eine Erklärung.
     */
    public static final String VORBEHALT_GEMESSEN = "vorbehalt_gemessen";
    /** Die Erklärung ist unvollständig (422): {@code fehlt} nennt jede Lücke mit ihrer Kennung. */
    public static final String ERKLAERUNG_UNVOLLSTAENDIG = "erklaerung_unvollstaendig";
    /** Sprungprobe außerhalb von S1 {@code beobachtet} (IP-21, §5.3): sie gehört vor das Scharfschalten. */
    public static final String NICHT_BEOBACHTET = "nicht_beobachtet";
    /** Sprungprobe an einer Box, die die Fähigkeit {@code sprungprobe} nicht meldet (IP-21). */
    public static final String SPRUNGPROBE_NICHT_GEMELDET = "sprungprobe_nicht_gemeldet";
    /** In der Anlage läuft schon eine Sprungprobe: zwei Sprünge am selben Netzpunkt wären nicht zu trennen. */
    public static final String SPRUNGPROBE_LAEUFT = "sprungprobe_laeuft";
    /** Der Netzpunkt der führenden Box hat keinen frischen Wert — ausgewertet würde gegen Unbekanntes (IP-21). */
    public static final String NETZPUNKT_NICHT_FRISCH = "netzpunkt_nicht_frisch";
    /** Der Auftrag erreichte die Box nicht; es gibt kein Protokoll (IP-21). */
    public static final String NICHT_ZUGESTELLT = "nicht_zugestellt";

    /** Die Übergangs-Gründe (409) in ihrer Vertrags-Reihenfolge. */
    public static final List<String> UEBERGANG = List.of(NICHT_EINGERICHTET, NICHT_AKTIV, NICHT_ANGEHALTEN,
            VOM_BETREIBER_ANGEHALTEN, BEREITS_AKTIV, ERST_ANHALTEN, ANTEILE_IN_KRAFT, KEIN_MITGLIED, BEREITS_BESTAETIGT,
            KEIN_VORSCHLAG, VORBEHALT_GEMESSEN, NICHT_BEOBACHTET, SPRUNGPROBE_NICHT_GEMELDET, SPRUNGPROBE_LAEUFT,
            NETZPUNKT_NICHT_FRISCH, NICHT_ZUGESTELLT);

    private final int status;
    private final String code;
    private final List<?> fehlt;

    private GemeinsameSteuerungAbgelehnt(int status, String code, String satz, List<?> fehlt) {
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

    /**
     * Die Erklärung ist unvollständig (422 {@code erklaerung_unvollstaendig}): je Lücke ein Eintrag {@code wort}
     * ({@code geraete} · {@code komponente} · {@code ungesteuerte_erzeuger}) mit Box bzw. Komponente, wo sie daran hängt.
     */
    public static GemeinsameSteuerungAbgelehnt unvollstaendig(String satz,
            List<GemeinsameSteuerungEinrichtenDto.Luecke> luecken) {
        return new GemeinsameSteuerungAbgelehnt(422, ERKLAERUNG_UNVOLLSTAENDIG, satz, luecken);
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    /**
     * {@code {code, message, fehlt}} — {@code fehlt} nur bei einem Wort des Ablehnungs-Vokabulars und bei
     * {@code erklaerung_unvollstaendig}.
     */
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
