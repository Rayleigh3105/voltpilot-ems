package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Kostenstellen- und Prozess-Schnittstelle (UEMS AP-10 IP-7): Code, Status und
 * Kundensatz aus dem geschlossenen Satz {@link Ablehnung}, dazu die Fakten des Urteils (snake_case).
 * Wenn sie fliegt, ist nichts geschrieben.
 */
public final class KostenstelleProzessAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code KostenstelleProzessFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400,
                "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Nicht gefunden."),
        UNTERNEHMEN_NICHT_ANGELEGT("unternehmen_nicht_angelegt", 409,
                "Für diesen Kundenbereich ist noch kein Unternehmen angelegt."),
        KENNZEICHEN_FORMAT("kennzeichen_format", 422,
                "Ein Kennzeichen hat 2 bis 16 Zeichen aus A–Z, 0–9, „.“, „/“ und „-“."),
        KENNZEICHEN_BELEGT("kennzeichen_belegt", 409,
                "Dieses Kennzeichen ist schon vergeben — auch ein beendetes Objekt behält seins."),
        ZEITRAUM_UNGUELTIG("zeitraum_ungueltig", 422, "Der letzte Tag liegt vor dem ersten."),
        BEREITS_BEENDET("bereits_beendet", 409,
                "Das ist schon beendet — ein Ende lässt sich vorziehen, aber nicht hinausschieben."),
        ZUORDNUNG_BESTEHT("zuordnung_besteht", 409,
                "Zuordnungen gelten über dieses Ende hinaus. Beenden Sie zuerst die Zuordnungen — gelöscht wird nichts."),
        EINE_EBENE("eine_ebene", 422,
                "Prozesse haben höchstens eine Ebene: ein Unterprozess kann selbst keine Unterprozesse haben."),
        ELTERN_UNBEKANNT("eltern_unbekannt", 422, "Den gewählten übergeordneten Prozess gibt es nicht."),
        PROZESS_UNBEKANNT("prozess_unbekannt", 422, "Einen der gewählten Prozesse gibt es nicht."),
        ZIEL_BESTEHT_NICHT("ziel_besteht_nicht", 422,
                "Das Ziel besteht an diesen Tagen nicht — eine Zuordnung gilt nie länger als ihr Ziel."),
        MESSSTELLE_ARCHIVIERT("messstelle_archiviert", 409,
                "Die Messstelle ist archiviert — eine archivierte Messstelle bleibt, wie sie ist."),
        ZUORDNUNG_UEBERLAPPT("zuordnung_ueberlappt", 409,
                "Soeben wurde eine andere Zuordnung eingetragen. Laden Sie neu und versuchen Sie es noch einmal.");

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

    /** Alle Codes, die die Schnittstelle je antwortet. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    public KostenstelleProzessAbgelehnt(Ablehnung ablehnung, Map<String, Object> fakten) {
        super(ablehnung.satz());
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static KostenstelleProzessAbgelehnt von(Ablehnung ablehnung) {
        return new KostenstelleProzessAbgelehnt(ablehnung, Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static KostenstelleProzessAbgelehnt anfrage(String feld) {
        return new KostenstelleProzessAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
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
