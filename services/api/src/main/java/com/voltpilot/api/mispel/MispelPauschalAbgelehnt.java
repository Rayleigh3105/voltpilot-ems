package com.voltpilot.api.mispel;

/**
 * Ein Jahreslauf der Pauschaloption, der nicht rechnen darf (MiSpeL MP-25): ein Code und ein Satz mit Fundstelle —
 * gespeichert wird dann nichts. Codes: {@code formelsatz_unbekannt}, {@code vorgaben_ungueltig},
 * {@code anlage_unbekannt}, {@code foerderweg_nicht_pauschal}, {@code aw_regel_wechselt}, {@code zaehler_fehlt},
 * {@code messkonzept_anlage_1}, {@code bestimmungsrelevante_aenderung}, {@code zaehlerwechsel_im_zeitraum},
 * {@code einheit_passt_nicht}, {@code keine_werte}.
 */
public final class MispelPauschalAbgelehnt extends RuntimeException {

    private final String code;

    public MispelPauschalAbgelehnt(String code, String satz) {
        super(satz);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
