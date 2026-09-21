package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Die WIRKSAMEN Anteile einer Box je Richtung, wie sie ihr Herzschlag meldet (Y3, A18). Für jeden Zweischritt ist
 * „alt“ das, was die Boxen als wirksam melden — nicht, was die Cloud zu wissen glaubt.
 *
 * <p>Die Bean ist {@link WirksameAnteileAusHerzschlag} (IP-17: der Herzschlag-Block trägt {@code anteile_kw}). Meldet
 * ein Mitglied nichts, nimmt {@link SteuerungsverbundAnteilDienst} die gesendeten und quittierten Dokumente — und nach
 * einem erkannten Rückspielen gar nichts (dann kein Scharfschalten).
 */
public interface WirksameAnteileQuelle {

    /** Leer = die Box hat (noch) keine Anteile gemeldet; unbekannt ist keine Null. */
    Optional<Map<Grenzart, BigDecimal>> wirksam(UUID siteId, UUID box);
}
