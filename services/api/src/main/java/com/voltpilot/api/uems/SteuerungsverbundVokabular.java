package com.voltpilot.api.uems;

/**
 * Die geschlossenen Vokabulare der Gemeinsamen Steuerung (UEMS AP-15 IP-2, Vertrag {@code steuerungsverbund.md}).
 * Jedes Wort steht so in {@code docs/contracts/v2/verbund-anteil-vectors.json} → {@code vokabulare}; der
 * Vektortest vergleicht Reihenfolge und Wortlaut mit der Python-Referenz
 * ({@code services/optimization/tests/test_steuerungsverbund_referenz.py}), der Go-Zwilling kommt mit IP-17.
 * <b>Ein neues Wort ändert die Vektor-Datei UND alle Zwillinge.</b> Kundenwort ist „Gemeinsame Steuerung“ — diese
 * Codes erscheinen nie auf einer Kundenfläche.
 */
public final class SteuerungsverbundVokabular {

    private SteuerungsverbundVokabular() {}

    /** Rolle einer Box in ihrer Anlage. {@code LIEST} ist kein Mitglied (T6: Lesen macht kein Mitglied). */
    public enum Rolle {
        FUEHRT("fuehrt"),
        STEUERT_MIT("steuert_mit"),
        LIEST("liest");

        private final String code;

        Rolle(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /**
     * Stufe der Gemeinsamen Steuerung (I1–I5). S4 „Zuteilung auf Zeit“ ist mit E1 = A entworfen, nicht gebaut — es gibt
     * sie hier bewusst nicht; „angehalten“ trägt keine Nummer.
     */
    public enum Stufe {
        ERKLAERT("S0", "erklaert"),
        BEOBACHTET("S1", "beobachtet"),
        GEPRUEFT("S2", "geprueft"),
        ANTEILE_AKTIV("S3", "anteile_aktiv"),
        ANGEHALTEN(null, "angehalten");

        private final String stufe;
        private final String code;

        Stufe(String stufe, String code) {
            this.stufe = stufe;
            this.code = code;
        }

        public String stufe() {
            return stufe;
        }

        public String code() {
            return code;
        }
    }

    /** Art einer harten Grenze am Netzanschluss. */
    public enum Grenzart {
        EINSPEISUNG("einspeisung"),
        BEZUG("bezug"),
        NETZBETREIBER_VORGABE("netzbetreiber_vorgabe");

        private final String code;

        Grenzart(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Was ein Gerät tut, wenn seine Box schweigt; {@code UNBEKANNT} und {@code LAEUFT_FREI} zählen mit Nennleistung (G3). */
    public enum GeraeteRueckfall {
        HAELT_LETZTEN_WERT("haelt_letzten_wert"),
        FAELLT_AUF_WERT("faellt_auf_wert"),
        LAEUFT_FREI("laeuft_frei"),
        UNBEKANNT("unbekannt");

        private final String code;

        GeraeteRueckfall(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Urteil der Auslegungsprüfung je Richtung (G2, G3). */
    public enum AuslegungUrteil {
        PASST("passt"),
        AUSLEGUNG_PASST_NICHT("auslegung_passt_nicht"),
        VORBEHALT_UEBER_GRENZE("vorbehalt_ueber_grenze");

        private final String code;

        AuslegungUrteil(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Ablehnung beim Scharfschalten (T1, T2, T5, I1, G3/E2, B1/W2, G6/Z3, B3); Regeln des Verbund-Objekts: IP-4, Routen: IP-5. */
    public enum Ablehnung {
        BOX_NICHT_IN_ANLAGE("box_nicht_in_anlage"),
        KEIN_NETZANSCHLUSS("kein_netzanschluss"),
        GRENZE_FEHLT("grenze_fehlt"),
        FAEHIGKEIT_FEHLT("faehigkeit_fehlt"),
        NACHWEIS_FEHLT("nachweis_fehlt"),
        AUSLEGUNG_PASST_NICHT("auslegung_passt_nicht"),
        FUEHRENDE_BOX_MISST_NICHT("fuehrende_box_misst_nicht"),
        VORGABE_SIGNAL_NICHT_AN_JEDER_BOX("vorgabe_signal_nicht_an_jeder_box"),
        /** B3 (IP-4): der Messpunkt einer mitsteuernden Box ist keine Datenquelle ihrer Anlage oder wird nicht von ihr gelesen. */
        MITSTEUERNDE_BOX_MISST_NICHT("mitsteuernde_box_misst_nicht");

        private final String code;

        Ablehnung(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Urteil der Box über ein Anteils-Dokument. */
    public enum DokumentUrteil {
        ANGENOMMEN("angenommen"),
        ABGELEHNT("abgelehnt");

        private final String code;

        DokumentUrteil(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Warum eine Box ein Anteils-Dokument ablehnt (T4, G5, Y1) — in dieser Prüf-Reihenfolge. */
    public enum DokumentAblehnung {
        FREMDE_ANLAGE("fremde_anlage"),
        BOX_FEHLT_IM_DOKUMENT("box_fehlt_im_dokument"),
        REVISION_AELTER("revision_aelter"),
        SUMME_UEBER_VERTEILBAR("summe_ueber_verteilbar");

        private final String code;

        DokumentAblehnung(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
