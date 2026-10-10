package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.util.List;

/** K7: konstruiertes Tagesmittel → Gradtage. Die Rohwertbildung verwendet AP-08 M1–M6. */
public final class GradtagRegeln {
    private GradtagRegeln() {}
    public record Tag(BigDecimal mittel, String zustand) {}
    public record Ergebnis(BigDecimal betrag, String zustand, List<String> kennzeichen) {}
    public static String regel(BigDecimal raum, BigDecimal grenze) {
        return "Gradtage G" + raum.stripTrailingZeros().toPlainString() + "/" + grenze.stripTrailingZeros().toPlainString();
    }
    public static Ergebnis gradtage(List<Tag> tage, BigDecimal raum, BigDecimal grenze) {
        if (raum.compareTo(grenze)<=0) throw new IllegalArgumentException("Raumtemperatur muss über Heizgrenze liegen");
        BigDecimal summe=null;
        boolean voll=!tage.isEmpty();
        for (Tag tag:tage) {
            voll &= tag.mittel()!=null && VerbrauchRegeln.VOLLSTAENDIG.equals(tag.zustand());
            if (tag.mittel()!=null) {
                BigDecimal wert=tag.mittel().compareTo(grenze)<0 ? raum.subtract(tag.mittel()) : BigDecimal.ZERO;
                summe=summe==null ? wert : summe.add(wert);
            }
        }
        return new Ergebnis(summe,summe==null ? VerbrauchRegeln.KEINE_WERTE : voll ? VerbrauchRegeln.VOLLSTAENDIG : VerbrauchRegeln.UNVOLLSTAENDIG,
            voll ? List.of(regel(raum,grenze)) : List.of(regel(raum,grenze),"Tagesmittel fehlen oder sind unvollständig"));
    }
}
