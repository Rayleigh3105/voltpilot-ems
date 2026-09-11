package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Schreibrouten der Ortsstruktur (Unternehmen, Standort — und mit IP-5
 * Gebäude/Bereich): Code, HTTP-Status, deutscher Satz mit Grund und Weg (AP-02 §5.10) und
 * die Fakten des Urteils. Nichts ist geschrieben, wenn sie fliegt — auch kein
 * Protokolleintrag.
 *
 * <p>Die Sätze der Sperren (Namensregel, Archivieren, Wiederherstellen) kommen aus
 * {@link OrtsbaumAbleitung}, nie von hier; die Antwort-Form ist {@code {code, message,
 * …Fakten}} wie bei der Messstellen-Schnittstelle.
 */
public final class OrtAbgelehnt extends RuntimeException {

    /** Die Codes. Geschlossen — ein neuer Grund ist ein neuer Eintrag hier und in openapi.yaml. */
    public enum Grund {
        /** Ein Feld fehlt, hat die falsche Form oder gibt es an dieser Route nicht. */
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400),
        /** Den Ort gibt es nicht — oder er gehört einem anderen Kundenbereich (nie 403). */
        NICHT_GEFUNDEN("nicht_gefunden", 404),
        /** Der Name ist unter den Geschwistern vergeben (§4.1, Regel 13); {@code verweis} nennt den Träger. */
        NAME_BELEGT("name_belegt", 409),
        /** Das Kurzzeichen trägt oder trug ein anderer Ort (E8); {@code verweis} nennt ihn. */
        KURZZEICHEN_BELEGT("kurzzeichen_belegt", 409),
        /** Ein archivierter Ort wird nicht bearbeitet — erst wiederherstellen. */
        ARCHIVIERT("archiviert", 409),
        /** Archivieren gesperrt (E12); {@code gruende} ist die ganze Liste in fester Reihenfolge. */
        ARCHIVIEREN_GESPERRT("archivieren_gesperrt", 409),
        /** Wiederherstellen gesperrt; {@code grund} sagt, warum (nicht archiviert, Name belegt …). */
        WIEDERHERSTELLEN_GESPERRT("wiederherstellen_gesperrt", 409),
        // Die Gründe des Ortsbaum-Vertrags beim Anlegen und bei der Fläche (IP-5) — Code und
        // Satz aus OrtsbaumAbleitung#eintrag bzw. #flaecheEintrag, Status nach AP-02 §5.10.
        /** Woran der Ort hängen soll, geht nicht (Bereich unter Bereich, Gebäude unter Gebäude …). */
        ZIEL_ART_UNZULAESSIG("ziel_art_unzulaessig", 400),
        /** Der Elternknoten besteht am „gültig ab“ noch nicht; der Satz nennt seinen ersten Tag. */
        ZIEL_GAB_ES_NOCH_NICHT("ziel_gab_es_noch_nicht", 422),
        /** Der Elternknoten ist an einem Tag des neuen Intervalls archiviert. */
        ZIEL_ARCHIVIERT("ziel_archiviert", 409),
        /** Keine ganze Zahl größer als 0 (§5.10). */
        FLAECHE_UNGUELTIG("flaeche_ungueltig", 400),
        /** Den Ort gibt es am „gültig ab“ noch nicht; der Satz nennt seinen ersten Tag. */
        GAB_ES_NOCH_NICHT("gab_es_noch_nicht", 422),
        /** Dieselbe Fläche gilt an dem Tag schon — es gäbe nichts zu ändern. */
        GLEICHE_FLAECHE("gleiche_flaeche", 400);

        private final String code;
        private final int status;

        Grund(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /** Alle Codes, die die Routen je antworten. */
    public static final List<String> CODES = codes();

    private final Grund grund;
    private final Map<String, Object> fakten;

    private OrtAbgelehnt(Grund grund, String satz, Map<String, Object> fakten) {
        super(satz);
        this.grund = grund;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static OrtAbgelehnt von(Grund grund, String satz, Map<String, Object> fakten) {
        return new OrtAbgelehnt(grund, satz, fakten);
    }

    public static OrtAbgelehnt anfrage(String feld, String satz) {
        return new OrtAbgelehnt(Grund.ANFRAGE_UNGUELTIG, satz, Map.of("feld", feld));
    }

    public static OrtAbgelehnt nichtGefunden(String satz) {
        return new OrtAbgelehnt(Grund.NICHT_GEFUNDEN, satz, Map.of());
    }

    public String code() {
        return grund.code();
    }

    public int status() {
        return grund.status();
    }

    /** Die Fakten des Urteils, ohne Code und Satz. */
    public Map<String, Object> fakten() {
        return fakten;
    }

    private static List<String> codes() {
        List<String> alle = new ArrayList<>();
        for (Grund g : Grund.values()) {
            alle.add(g.code());
        }
        return List.copyOf(alle);
    }
}
