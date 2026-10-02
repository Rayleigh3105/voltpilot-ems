package com.voltpilot.api.mispel;

/**
 * Ein Monatslauf, der nicht rechnen darf (MiSpeL MP-8): ein Code und ein Satz mit Fundstelle — gespeichert wird dann
 * nichts. Codes: {@code formelsatz_unbekannt}, {@code vorgaben_ungueltig}, {@code zaehler_fehlt},
 * {@code bestimmungsrelevante_aenderung}, {@code einheit_passt_nicht}, {@code keine_werte}; aus MP-21
 * {@code zaehlerwechsel_im_zeitraum} und {@code wechsel_nur_zum_monatsersten}.
 */
public final class MispelAbgrenzungAbgelehnt extends RuntimeException {

    private final String code;

    public MispelAbgrenzungAbgelehnt(String code, String satz) {
        super(satz);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
