package com.voltpilot.api.uems;

import com.voltpilot.api.uems.DatenquelleRegeln.AntragErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import com.voltpilot.api.uems.DatenquelleRegeln.ZeitraumErgebnis;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine Ablehnung der Datenquellen-Schnittstelle (UEMS AP-06 IP-3): Code, HTTP-Status,
 * deutscher Satz und die Fakten des Urteils. Nichts ist geschrieben, wenn sie fliegt.
 *
 * <p>Zwei Quellen für den Code, sauber getrennt (Muster {@code MessstelleAbgelehnt}):
 * <ul>
 *   <li>{@link #regel}/{@link #zeitraum}: ein Grund des Vertrags
 *       ({@link DatenquelleRegeln.Grund}) — Code und Satz kommen von dort, nie von hier. Der
 *       Vertrag nennt keinen HTTP-Status; {@link #status(Grund)} ist die EINE Zuordnung.</li>
 *   <li>{@link Schnittstelle}: was der Regel-Vertrag nicht regelt, weil es die Form der Anfrage
 *       oder den gespeicherten Zustand betrifft (Vertrag §12: „Endpunkte … (IP-3)“).</li>
 * </ul>
 */
public final class DatenquelleAbgelehnt extends RuntimeException {

    /** Die Codes der Schnittstelle neben den Gründen des Vertrags. Geschlossen. */
    public enum Schnittstelle {
        /** Ein Feld fehlt, hat die falsche Form oder gibt es an dieser Route nicht. */
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400),
        /**
         * Protokoll, Adresse, Ein-Leser-Eigenschaft und Steuerquelle sind die Eingänge der
         * Antrags-Regeln; hat eine Box die Quelle schon gelesen (oder ist sie vorgemerkt),
         * bleiben sie.
         */
        WEG_FEST("weg_fest", 409),
        /** Eine archivierte Quelle wird nicht mehr bearbeitet, geprüft oder zugewiesen. */
        QUELLE_ARCHIVIERT("quelle_archiviert", 409),
        /** Für dieses Protokoll kennt der Prüf-Kanal der Box noch keinen Lese-Schritt. */
        PRUEFUNG_NICHT_MOEGLICH("pruefung_nicht_moeglich", 422),
        /**
         * Die Rückwand der Datenbank hat gegriffen (Exklusion/CHECK aus V20260911150000): ein
         * gleichzeitiger Schreibvorgang hat die Ausgangslage geändert. Der Grund des
         * Constraints steht als Fakt {@code grund} daneben.
         */
        GLEICHZEITIG_GEAENDERT("gleichzeitig_geaendert", 409),
        /**
         * Bestands-Übernahme (IP-4): eine Komponente des bestätigten Vorschlags hat inzwischen eine
         * Quelle — auf einem anderen Weg als diesem Vorschlag. Fakten: {@code komponenten},
         * {@code datenquellen}.
         */
        KOMPONENTE_HAT_QUELLE("komponente_hat_quelle", 409),
        /**
         * Bestands-Übernahme (IP-4): den bestätigten Vorschlag gibt es so nicht mehr (andere Box,
         * anderer Weg, andere Komponenten) — bestätigt wird nur, was gezeigt wurde.
         */
        VORSCHLAG_GEAENDERT("vorschlag_geaendert", 409),
        /** Das physische Lesebudget der Ziel-Box wäre nach dieser Quelle überschritten. */
        BUDGET_UEBERSCHRITTEN("budget_ueberschritten", 422);

        private final String code;
        private final int status;

        Schnittstelle(String code, int status) {
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

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    private DatenquelleAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /**
     * Der HTTP-Status je Grund des Vertrags: 400 für ein Wort außerhalb des Vokabulars, 422 für
     * einen in sich ungültigen Wunsch (Zeitpunkt bzw. Ein-Leser-Vorlage), 409 für alles, was am
     * gespeicherten Stand scheitert — auch „erst bestätigen“ und „erst prüfen“.
     */
    public static int status(Grund g) {
        return switch (g) {
            case PROTOKOLL_UNBEKANNT -> 400;
            case KEINE_VOLLE_MINUTE, RUECKWIRKEND, LEERER_ZEITRAUM, NUR_EIN_LESER -> 422;
            case STEUERQUELLE, SPAETERER_WECHSEL_GEPLANT, SCHON_ZUSTAENDIG, UEBERSCHNEIDUNG,
                    ADRESSE_AN_BOX_VERGEBEN, NETZLAGE_FEHLT, VERGLEICH_BESTAETIGEN,
                    PRUEFUNG_FEHLT, PRUEFUNG_GESCHEITERT -> 409;
        };
    }

    /** Ein Urteil von {@link DatenquelleRegeln#pruefeAntrag}, das nicht „erlaubt“ ist. */
    public static DatenquelleAbgelehnt regel(AntragErgebnis e) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("urteil", e.urteil().code());
        fakten.put("grund", e.grund().code());
        fakten.put("satz", e.text());
        return new DatenquelleAbgelehnt(e.grund().code(), status(e.grund()), e.text(), fakten);
    }

    /** Ein Urteil der Speicher-Regel {@link DatenquelleRegeln#pruefeZeitraum}. */
    public static DatenquelleAbgelehnt zeitraum(ZeitraumErgebnis e) {
        return new DatenquelleAbgelehnt(e.grund().code(), status(e.grund()), e.text(), Map.of(
                "urteil", DatenquelleRegeln.Urteil.ABGELEHNT.code(),
                "grund", e.grund().code(), "satz", e.text()));
    }

    /** Ein Grund des Vertrags ohne Platzhalter im Satz (heute: {@code protokoll_unbekannt}). */
    public static DatenquelleAbgelehnt grund(Grund g) {
        return new DatenquelleAbgelehnt(g.code(), status(g), g.text(),
                Map.of("urteil", g.urteil().code(), "grund", g.code(), "satz", g.text()));
    }

    public static DatenquelleAbgelehnt schnittstelle(Schnittstelle s, String satz, Map<String, Object> fakten) {
        return new DatenquelleAbgelehnt(s.code(), s.status(), satz, fakten);
    }

    public static DatenquelleAbgelehnt anfrage(String feld, String satz) {
        return schnittstelle(Schnittstelle.ANFRAGE_UNGUELTIG, satz, Map.of("feld", feld));
    }

    /** E6: die ganze Rechnung und beide Auswege reisen im 422-Körper; geschrieben ist noch nichts. */
    public static DatenquelleAbgelehnt budget(DatenquelleBudget.Ablehnung b) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("urteil", "abgelehnt");
        fakten.put("rechnung", b);
        return new DatenquelleAbgelehnt(Schnittstelle.BUDGET_UEBERSCHRITTEN.code(),
                Schnittstelle.BUDGET_UEBERSCHRITTEN.status(),
                "Diese Quelle passt nicht mehr in das Lesebudget von " + b.box()
                        + " — Takt strecken oder andere Box wählen.", fakten);
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    public Map<String, Object> fakten() {
        return fakten;
    }
}
