package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Verteilungs-Schnittstelle (UEMS AP-10 IP-8): Code, Status und Kundensatz aus dem
 * geschlossenen Satz {@link Ablehnung}, dazu die Fakten des Urteils (snake_case). Wenn sie fliegt, ist nichts
 * geschrieben — auch kein Protokoll und kein Ereignis.
 */
public final class VerteilungAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code VerteilungFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400,
                "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Nicht gefunden."),
        UNTERNEHMEN_NICHT_ANGELEGT("unternehmen_nicht_angelegt", 409,
                "Für diesen Kundenbereich ist noch kein Unternehmen angelegt."),
        MESSSTELLE_ARCHIVIERT("messstelle_archiviert", 409,
                "Die Messstelle ist archiviert — eine archivierte Messstelle bleibt, wie sie ist."),
        KOSTENSTELLE_UNBEKANNT("kostenstelle_unbekannt", 422, "Eine der gewählten Kostenstellen gibt es nicht."),
        ANTEIL_UNGUELTIG(VerteilungRegeln.FEHLER_ANTEIL, 422,
                "Ein Anteil liegt über 0 und höchstens bei 100 Prozent, mit höchstens einer Nachkommastelle."),
        ZIEL_BESTEHT_NICHT(VerteilungRegeln.FEHLER_ZIEL, 422,
                "Die Kostenstelle besteht an diesem Tag nicht — ein Anteil gilt nie länger als seine Kostenstelle."),
        VERTEILUNG_SUMME(VerteilungRegeln.FEHLER_SUMME, 422,
                "Die Anteile eines Tages ergeben zusammen genau 100 Prozent. Ein Rest wird nicht verteilt und "
                        + "nie geschätzt — ohne Anteile ist die Messstelle an diesem Tag nicht verteilt."),
        FORMEL_FASSUNG_UEBERLAPPT(VerteilungRegeln.FEHLER_UEBERLAPPT, 422,
                "An diesem Tag oder danach beginnt schon eine Verteilung. Eine neue beginnt nach ihr — "
                        + "oder ersetzt die vom selben Tag als Berichtigung."),
        ZUORDNUNG_UEBERLAPPT("zuordnung_ueberlappt", 409,
                "Soeben wurde eine andere Verteilung eingetragen. Laden Sie neu und versuchen Sie es noch einmal.");

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

        /** Die Ablehnung zu einem Fehler-Wort der Regel {@link VerteilungRegeln#satzAbTag}. */
        static Ablehnung ausRegel(String fehler) {
            return Arrays.stream(values()).filter(a -> a.code.equals(fehler)).findFirst()
                    .orElseThrow(() -> new IllegalStateException("Regel-Fehler ohne Ablehnung: " + fehler));
        }
    }

    /** Alle Codes, die die Schnittstelle je antwortet. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    public VerteilungAbgelehnt(Ablehnung ablehnung, Map<String, Object> fakten) {
        super(ablehnung.satz());
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static VerteilungAbgelehnt von(Ablehnung ablehnung) {
        return new VerteilungAbgelehnt(ablehnung, Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static VerteilungAbgelehnt anfrage(String feld) {
        return new VerteilungAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
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
