package com.voltpilot.api.uems;

import java.math.BigDecimal;

/**
 * Die Entfernung zweier Punkte auf der Karte (Haversine, Kugel-Näherung — für die Schwellen
 * des Standort-Konzepts (vp-standort-konzept §6.6, 2 km) genau genug).
 */
public final class GeoAbstand {

    private static final double ERDRADIUS_KM = 6371.0;

    private GeoAbstand() {}

    /** Die Entfernung zweier Punkte in Kilometern (Großkreis). */
    public static double kilometer(BigDecimal breite1, BigDecimal laenge1, BigDecimal breite2, BigDecimal laenge2) {
        double phi1 = Math.toRadians(breite1.doubleValue());
        double phi2 = Math.toRadians(breite2.doubleValue());
        double dPhi = Math.toRadians(breite2.subtract(breite1).doubleValue());
        double dLambda = Math.toRadians(laenge2.subtract(laenge1).doubleValue());
        double a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2)
                + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return ERDRADIUS_KM * c;
    }
}
