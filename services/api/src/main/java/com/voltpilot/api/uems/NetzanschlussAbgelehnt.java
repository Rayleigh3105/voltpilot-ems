package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Netzanschluss-Schnittstelle (UEMS AP-10 IP-6): Code, Status und Kundensatz aus
 * dem geschlossenen Satz {@link Ablehnung}, dazu die Fakten des Urteils (snake_case). Wenn sie fliegt,
 * ist nichts geschrieben.
 *
 * <p>Die Codes des Vertrags ({@code docs/contracts/v2/netzanschluss-vectors.json},
 * {@code vokabulare.fehler}) kommen aus {@link NetzanschlussRegeln} und stehen hier mit IHREM Wort;
 * die übrigen sind die des Schreibwegs (Hausmuster PR #717).
 */
public final class NetzanschlussAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code NetzanschlussFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG(NetzanschlussRegeln.FEHLER_ANFRAGE, 400,
                "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Nicht gefunden."),
        KENNZEICHEN_FORMAT(NetzanschlussRegeln.FEHLER_KENNZEICHEN_FORMAT, 422,
                "Ein Kennzeichen hat 2 bis 16 Zeichen aus A–Z, 0–9, „.“, „/“ und „-“."),
        KENNZEICHEN_BELEGT(NetzanschlussRegeln.FEHLER_KENNZEICHEN_BELEGT, 409,
                "Dieses Kennzeichen ist schon vergeben — auch ein beendeter oder umbenannter Netzanschluss behält seins."),
        MALO_FORM(NetzanschlussRegeln.FEHLER_MALO, 422,
                "Eine Marktlokation hat genau elf Ziffern — eine kürzere Nummer wird nicht aufgefüllt."),
        ZEITRAUM_UNGUELTIG("zeitraum_ungueltig", 422, "Der letzte Tag liegt vor dem ersten."),
        BEREITS_BEENDET("bereits_beendet", 409,
                "Der Netzanschluss ist schon beendet — ein Ende lässt sich vorziehen, aber nicht hinausschieben."),
        BINDUNG_BESTEHT("bindung_besteht", 409,
                "Anlagen hängen über diese Tage hinaus an diesem Netzanschluss. Beenden Sie zuerst die Bindungen — gelöscht wird nichts."),
        ANLAGE_UNBEKANNT("anlage_unbekannt", 422, "Die gewählte Anlage gibt es nicht."),
        NETZANSCHLUSS_BESTEHT_NICHT("netzanschluss_besteht_nicht", 422,
                "Der Netzanschluss besteht an diesen Tagen nicht — eine Bindung gilt nie länger als ihr Netzanschluss."),
        BINDUNG_UEBERLAPPT(NetzanschlussRegeln.FEHLER_BINDUNG_UEBERLAPPT, 409,
                "Die Anlage hängt an diesem Tag schon an einem Netzanschluss. Ein Wechsel beginnt nach dem Tag der laufenden Bindung — sie endet dann am Vortag."),
        ANSCHLUSS_BELEGT(NetzanschlussRegeln.FEHLER_ANSCHLUSS_BELEGT, 409,
                "Der Netzanschluss hängt an diesen Tagen schon an einer anderen Anlage.");

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

        /** Die Ablehnung zu einem Code der Regeln; {@code null}, wenn der Code keiner des Satzes ist. */
        public static Ablehnung zuCode(String code) {
            return Arrays.stream(values()).filter(a -> a.code.equals(code)).findFirst().orElse(null);
        }
    }

    /** Alle Codes, die die Schnittstelle je antwortet. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    public NetzanschlussAbgelehnt(Ablehnung ablehnung, Map<String, Object> fakten) {
        super(ablehnung.satz());
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static NetzanschlussAbgelehnt von(Ablehnung ablehnung) {
        return new NetzanschlussAbgelehnt(ablehnung, Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static NetzanschlussAbgelehnt anfrage(String feld) {
        return new NetzanschlussAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
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
