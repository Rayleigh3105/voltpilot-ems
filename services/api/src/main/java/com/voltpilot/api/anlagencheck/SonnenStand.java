package com.voltpilot.api.anlagencheck;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

/**
 * Die Sonnenhöhe über dem Horizont (Grad) - die vereinfachte NOAA-Formel, auf etwa ein Zehntel Grad genau. Rein; der
 * Anlagen-Check fragt damit nur, ob eine Stunde „tagsüber" ist (Regel {@link AnlagenCheckRegel#TAG_AB_GRAD}): dann ist
 * ein fehlender Messwert eine Lücke, nachts schläft der Wechselrichter und es zählt 0.
 */
public final class SonnenStand {

    private SonnenStand() {
    }

    /** Sonnenhöhe in Grad am Ort ({@code breite}, {@code laenge} in Grad, Ost positiv) zum Zeitpunkt. */
    public static double hoehe(double breite, double laenge, Instant zeit) {
        ZonedDateTime utc = zeit.atZone(ZoneOffset.UTC);
        double stunde = utc.getHour() + utc.getMinute() / 60.0 + utc.getSecond() / 3600.0;
        double gamma = 2 * Math.PI / (utc.toLocalDate().lengthOfYear()) * (utc.getDayOfYear() - 1 + (stunde - 12) / 24);
        double zeitgleichung = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
                - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
        double deklination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
                - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
                - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
        double wahreZeitMin = stunde * 60 + zeitgleichung + 4 * laenge;
        double stundenwinkel = Math.toRadians(wahreZeitMin / 4 - 180);
        double phi = Math.toRadians(breite);
        double cosZenit = Math.sin(phi) * Math.sin(deklination)
                + Math.cos(phi) * Math.cos(deklination) * Math.cos(stundenwinkel);
        cosZenit = Math.max(-1, Math.min(1, cosZenit));
        return 90 - Math.toDegrees(Math.acos(cosZenit));
    }
}
