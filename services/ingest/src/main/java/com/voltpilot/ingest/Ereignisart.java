package com.voltpilot.ingest;

/**
 * Die Arten, die die Datenannahme SELBST meldet (Urheber {@code datenannahme}, AP-07 §4.8), mit
 * dem Feld, das bei Zeitfehlern die Sekunden trägt. {@code clock_jump} fehlt bewusst: er
 * vergleicht aufeinanderfolgende Umschläge derselben Box — die zustandslose Datenannahme sieht
 * immer nur einen (siehe {@code docs/agents/root/uems-datenannahme-ereignisse.md}).
 */
public enum Ereignisart {
    REJECTED("rejected", null),
    CLOCK_AHEAD("clock_ahead", "vor_s"),
    TOO_OLD("too_old", "alter_s");

    private final String code;
    private final String sekundenFeld;

    Ereignisart(String code, String sekundenFeld) {
        this.code = code;
        this.sekundenFeld = sekundenFeld;
    }

    public String code() {
        return code;
    }

    /** {@code vor_s} / {@code alter_s}; {@code null} bei {@code rejected}. */
    public String sekundenFeld() {
        return sekundenFeld;
    }
}
