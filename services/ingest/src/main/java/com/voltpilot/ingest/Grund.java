package com.voltpilot.ingest;

/**
 * Der Ablehnungsgrund eines {@code rejected}-Ereignisses: das GESCHLOSSENE Vokabular aus
 * {@code docs/contracts/v2/events-vocabulary-vectors.json} ({@code vokabular.grund};
 * events-vocabulary.md §5). Die Datenannahme stellt alle fest außer
 * {@link #HERKUNFT_UNVOLLSTAENDIG} (das Wort des Writers). Zwilling:
 * {@code services/api .../uems/EreignisVokabular.Grund}; {@code DatenannahmeVertragTest} hält beide
 * an der Vektor-Datei.
 */
public enum Grund {
    HERKUNFT_UNVOLLSTAENDIG("herkunft_unvollstaendig"),
    FASSUNG_UNBEKANNT("fassung_unbekannt"),
    KENNUNG_ABWEICHEND("kennung_abweichend"),
    SCHEMA_VERLETZT("schema_verletzt"),
    WORT_UNBEKANNT("wort_unbekannt"),
    URHEBER_UNZULAESSIG("urheber_unzulaessig"),
    ZEIT_UNGUELTIG("zeit_ungueltig"),
    REGEL_VERLETZT("regel_verletzt"),
    FORTSCHREIBUNG_UNZULAESSIG("fortschreibung_unzulaessig");

    private final String code;

    Grund(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }
}
