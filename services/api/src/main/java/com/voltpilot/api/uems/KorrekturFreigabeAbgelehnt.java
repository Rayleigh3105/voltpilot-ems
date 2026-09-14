package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Korrektur-Routen (UEMS AP-08 IP-15): Code, Status und Kundensatz aus dem
 * geschlossenen Satz {@link Ablehnung}, dazu die Fakten des Urteils (snake_case). Wenn sie fliegt,
 * ist nichts geschrieben.
 *
 * <p>Die beiden 403 kommen aus der Rechte-Ableitung und tragen ihren Satz von dort
 * ({@link #rechte}); fremd ist immer {@code nicht_gefunden} — nie ein 403, das die Existenz verrät.
 */
public final class KorrekturFreigabeAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code KorrekturFreigabeFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400, "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Diese Seite gibt es für Sie nicht."),
        RECHT_FEHLT("recht_fehlt", 403, "Dafür fehlt Ihnen das Recht."),
        ZWEITE_PERSON_NOETIG("zweite_person_noetig", 403, "Freigabe durch eine zweite Person."),
        BEGRUENDUNG_FEHLT("begruendung_fehlt", 422,
                "Eine Begründung mit 10 bis 500 Zeichen ist Pflicht — sie steht im Protokoll der Korrektur."),
        STATUS_PASST_NICHT("status_passt_nicht", 409,
                "Freigeben lässt sich nur ein Vorschlag, zurücknehmen nur eine freigegebene Korrektur."),
        GLEICHZEITIG("gleichzeitig", 409,
                "Soeben hat jemand anderes über diese Korrektur entschieden. Laden Sie neu."),
        UNTERNEHMEN_NICHT_ANGELEGT("unternehmen_nicht_angelegt", 409,
                "Für diesen Kundenbereich ist noch kein Unternehmen angelegt.");

        private final String code;
        private final int status;
        private final String satz;

        Ablehnung(String code, int status, String satz) {
            this.code = code;
            this.status = status;
            this.satz = satz;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        public String satz() {
            return satz;
        }
    }

    /** Alle Codes, die die Routen je antworten. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    private KorrekturFreigabeAbgelehnt(Ablehnung ablehnung, String satz, Map<String, Object> fakten) {
        super(satz);
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static KorrekturFreigabeAbgelehnt von(Ablehnung ablehnung) {
        return new KorrekturFreigabeAbgelehnt(ablehnung, ablehnung.satz(), Map.of());
    }

    public static KorrekturFreigabeAbgelehnt von(Ablehnung ablehnung, Map<String, Object> fakten) {
        return new KorrekturFreigabeAbgelehnt(ablehnung, ablehnung.satz(), fakten);
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static KorrekturFreigabeAbgelehnt anfrage(String feld) {
        return von(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
    }

    /**
     * Das Nein der Rechte-Ableitung als Ablehnung: 404 bleibt {@code nicht_gefunden}; 403 trägt den Satz
     * der Ableitung und — wo es eine gibt — die kleinste Rolle, die es dürfte ({@code rolle_noetig}).
     */
    public static KorrekturFreigabeAbgelehnt rechte(RechteAbleitung.DarfErgebnis d) {
        if (d.http() != 403) {
            return von(Ablehnung.NICHT_GEFUNDEN);
        }
        Ablehnung a = d.grund() == RechteAbleitung.Grund.ZWEITE_PERSON_NOETIG
                ? Ablehnung.ZWEITE_PERSON_NOETIG
                : Ablehnung.RECHT_FEHLT;
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("rolle_noetig", d.rolleNoetig() == null ? null : d.rolleNoetig().code());
        return new KorrekturFreigabeAbgelehnt(a, d.text() == null ? a.satz() : d.text(), fakten);
    }

    public Ablehnung ablehnung() {
        return ablehnung;
    }

    public String code() {
        return ablehnung.code();
    }

    public int status() {
        return ablehnung.status();
    }

    public Map<String, Object> fakten() {
        return fakten;
    }
}
