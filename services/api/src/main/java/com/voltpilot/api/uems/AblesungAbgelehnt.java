package com.voltpilot.api.uems;

import java.util.Map;

/** Geschlossene Ablehnungen des Ablesungs-Schreibwegs (AP-09 IP-8). */
public class AblesungAbgelehnt extends RuntimeException {
    public enum Grund {
        ANFRAGE_UNGUELTIG(400, "Die Eingabe ist nicht lesbar."),
        NICHT_GEFUNDEN(404, "Messstelle oder Ablesung nicht gefunden."),
        QUELLE_PASST_NICHT(422, "Diese Messstelle wird nicht manuell abgelesen."),
        ZEITPUNKT_UNGUELTIG(422, "Datum und Uhrzeit prüfen."),
        WERT_UNGUELTIG(422, "Einen nicht negativen Zählerstand eingeben."),
        RUECKSPRUNG(422, "Rücksprung — Zählerwechsel eintragen?"),
        KONFLIKT(409, "Für diesen Zeitpunkt gibt es bereits eine Ablesung — berichtigen?"),
        BEGRUENDUNG_FEHLT(422, "Die Berichtigung braucht eine Begründung mit 10 bis 500 Zeichen."),
        VORSCHLAG_OFFEN(409, "Für diese Ablesung wartet bereits eine Berichtigung auf Freigabe."),
        GLEICHZEITIG(409, "Die Ablesung wurde inzwischen berichtigt. Bitte neu laden.");
        public final int status;
        public final String text;
        Grund(int status, String text) { this.status = status; this.text = text; }
    }
    public final Grund grund;
    public final Map<String, Object> fakten;
    public AblesungAbgelehnt(Grund grund) { this(grund, Map.of()); }
    public AblesungAbgelehnt(Grund grund, Map<String, Object> fakten) {
        super(grund.text); this.grund = grund; this.fakten = fakten;
    }
}
