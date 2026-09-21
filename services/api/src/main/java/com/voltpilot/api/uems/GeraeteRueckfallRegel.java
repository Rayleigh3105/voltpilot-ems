package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;

/**
 * Der Geräte-Rückfall EINER Komponente in EINER Richtung (UEMS AP-15 IP-6, Regel G3, Kasten E2 = A) — die einzige
 * Stelle, die aus Angaben eine Zahl macht: der am Gerät hinterlegte Wert ({@code komponente_geraete_rueckfall}),
 * sonst der Eintrag des Katalogs für die Familie ({@code families[].rueckfall_ohne_box}), sonst {@code unbekannt}.
 * Gezählt wird zur sicheren Seite: nur {@code faellt_auf_wert} mit einer Zahl zählt weniger als die Nennleistung —
 * {@code unbekannt}, {@code laeuft_frei} und {@code haelt_letzten_wert} (der letzte Wert kann alles bis zur
 * Nennleistung gewesen sein, R4: 83 kW) zählen mit ihr; ein Wert über der Nennleistung zählt mit der Nennleistung,
 * weil das Gerät nicht mehr kann. Das Ergebnis ist der Eingang, den IP-7 je Box in
 * {@link SteuerungsverbundAnteile.Mitglied#rueckfallKw()} summiert. Rein, ohne Datenbank.
 */
public final class GeraeteRueckfallRegel {

    private GeraeteRueckfallRegel() {}

    /** Woher die Zahl kommt — in dieser Reihenfolge gefragt. */
    public enum Herkunft {
        AM_GERAET("am_geraet"),
        KATALOG("katalog"),
        OHNE_ANGABE("ohne_angabe");

        private final String code;

        Herkunft(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /**
     * Eine Angabe — am Gerät hinterlegt oder aus dem Katalog. {@code rueckfallKw} gibt es genau bei
     * {@code faellt_auf_wert}; im Katalog darf sie dort fehlen: dann ist der Wert am Gerät einstellbar, aber
     * nicht bekannt, und es zählt die Nennleistung.
     */
    public record Angabe(GeraeteRueckfall rueckfall, BigDecimal rueckfallKw, Integer nachS) {

        public Angabe {
            if (rueckfall == null) {
                throw new IllegalArgumentException("rueckfall fehlt");
            }
            if (rueckfallKw != null && (rueckfall != GeraeteRueckfall.FAELLT_AUF_WERT || rueckfallKw.signum() < 0)) {
                throw new IllegalArgumentException("eine Zahl nur bei faellt_auf_wert und nie negativ: " + rueckfallKw);
            }
            if (nachS != null && nachS < 0) {
                throw new IllegalArgumentException("nach_s negativ: " + nachS);
            }
        }
    }

    /** Das Ergebnis: was das Gerät tut, womit es zählt und woher die Angabe kommt. */
    public record Rueckfall(Grenzart richtung, GeraeteRueckfall rueckfall, BigDecimal kw, Integer nachS,
            Herkunft herkunft) {}

    /**
     * @param richtung  {@code einspeisung} oder {@code bezug}
     * @param amGeraet  die wirksame Angabe der Komponente in dieser Richtung, oder {@code null}
     * @param katalog   der Katalog-Eintrag der Familie in dieser Richtung, oder {@code null}
     * @param nennKw    die Nennleistung der Komponente in dieser Richtung (≥ 0)
     */
    public static Rueckfall rueckfall(Grenzart richtung, Angabe amGeraet, Angabe katalog, BigDecimal nennKw) {
        if (richtung != Grenzart.EINSPEISUNG && richtung != Grenzart.BEZUG) {
            throw new IllegalArgumentException("nur einspeisung und bezug: " + richtung);
        }
        if (nennKw == null || nennKw.signum() < 0) {
            throw new IllegalArgumentException("Nennleistung fehlt oder ist negativ: " + nennKw);
        }
        Angabe angabe = amGeraet != null ? amGeraet : katalog;
        Herkunft herkunft = amGeraet != null ? Herkunft.AM_GERAET : katalog != null ? Herkunft.KATALOG
                : Herkunft.OHNE_ANGABE;
        if (angabe == null) {
            return new Rueckfall(richtung, GeraeteRueckfall.UNBEKANNT, nennKw, null, herkunft);
        }
        BigDecimal kw = angabe.rueckfallKw() == null ? nennKw : angabe.rueckfallKw().min(nennKw);
        return new Rueckfall(richtung, angabe.rueckfall(), kw, angabe.nachS(), herkunft);
    }
}
