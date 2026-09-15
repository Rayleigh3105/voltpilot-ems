package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Berichts-Routen (UEMS AP-12 IP-7): Code, Status und Kundensatz aus dem geschlossenen Satz
 * {@link Ablehnung}, dazu die Fakten des Urteils (snake_case). Wenn sie fliegt, ist nichts geschrieben.
 *
 * <p>Die Codes des Vertrags (§5.8, {@link BerichtRegeln#FEHLER_STATUS}) tragen Status und Satz der Regel; die übrigen
 * sind Codes der Schnittstelle. Ein 403 trägt den Satz der Rechte-Ableitung ({@link #rechte}); fremd ist immer
 * {@code nicht_gefunden} — nie ein 403, das die Existenz verrät.
 */
public final class BerichtAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code BerichtFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400, "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Diese Seite gibt es für Sie nicht."),
        RECHT_FEHLT("recht_fehlt", 403, "Dafür fehlt Ihnen das Recht."),
        VORLAGE_UNBEKANNT(BerichtRegeln.VORLAGE_UNBEKANNT),
        GELTUNG_UNBEKANNT(BerichtRegeln.GELTUNG_UNBEKANNT),
        BERICHT_GIBT_ES_SCHON(BerichtRegeln.BERICHT_GIBT_ES_SCHON),
        KEINE_QUELLEN(BerichtRegeln.KEINE_QUELLEN),
        ZEITRAUM_NICHT_ZU_ENDE(BerichtRegeln.ZEITRAUM_NICHT_ZU_ENDE),
        WERTE_VORLAEUFIG(BerichtRegeln.WERTE_VORLAEUFIG),
        ENTWURF_VERALTET(BerichtRegeln.ENTWURF_VERALTET),
        STAND_GIBT_ES_NICHT(BerichtRegeln.STAND_GIBT_ES_NICHT),
        ABZUG_BESCHAEDIGT(BerichtRegeln.ABZUG_BESCHAEDIGT),
        BEGRUENDUNG_FEHLT("begruendung_fehlt", 422,
                "Eine Begründung mit 10 bis 500 Zeichen ist Pflicht — sie bleibt am Anstoß sichtbar."),
        ANSTOSS_NICHT_OFFEN("anstoss_nicht_offen", 409,
                "Verwerfen lässt sich nur ein offener Anstoß — dieser ist schon erledigt oder verworfen."),
        GLEICHZEITIG("gleichzeitig", 409, "Soeben hat jemand anderes an diesem Bericht gearbeitet. Laden Sie neu."),
        UNTERNEHMENSBERICHT_FOLGT("unternehmensbericht_folgt", 501,
                "Den Inhalt eines Unternehmensberichts kann VoltPilot noch nicht zusammenstellen.");

        private final String code;
        private final int status;
        private final String satz;

        Ablehnung(String code, int status, String satz) {
            this.code = code;
            this.status = status;
            this.satz = satz;
        }

        /** Ein Code des Vertrags: Status aus {@link BerichtRegeln#FEHLER_STATUS}, der Satz kommt je Fall von der Regel. */
        Ablehnung(String code) {
            this(code, BerichtRegeln.FEHLER_STATUS.get(code), code);
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

    private BerichtAbgelehnt(Ablehnung ablehnung, String satz, Map<String, Object> fakten) {
        super(satz);
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static BerichtAbgelehnt von(Ablehnung ablehnung) {
        return new BerichtAbgelehnt(ablehnung, ablehnung.satz(), Map.of());
    }

    public static BerichtAbgelehnt von(Ablehnung ablehnung, Map<String, Object> fakten) {
        return new BerichtAbgelehnt(ablehnung, ablehnung.satz(), fakten);
    }

    /** Ein Code des Vertrags mit dem Kundensatz, den die Regel für DIESEN Fall spricht. */
    public static BerichtAbgelehnt regel(Ablehnung ablehnung, String kundensatz, Map<String, Object> fakten) {
        return new BerichtAbgelehnt(ablehnung, kundensatz, fakten);
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static BerichtAbgelehnt anfrage(String feld) {
        return von(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
    }

    /**
     * Das Nein der Rechte-Ableitung als Ablehnung: 404 bleibt {@code nicht_gefunden}; 403 trägt den Satz der Ableitung und
     * — wo es eine gibt — die kleinste Rolle, die es dürfte ({@code rolle_noetig}; beim Unterstützer {@code null} = nie).
     */
    public static BerichtAbgelehnt rechte(RechteAbleitung.DarfErgebnis d) {
        if (d.http() != 403) {
            return von(Ablehnung.NICHT_GEFUNDEN);
        }
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("rolle_noetig", d.rolleNoetig() == null ? null : d.rolleNoetig().code());
        return new BerichtAbgelehnt(Ablehnung.RECHT_FEHLT, d.text() == null ? Ablehnung.RECHT_FEHLT.satz() : d.text(),
                fakten);
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
