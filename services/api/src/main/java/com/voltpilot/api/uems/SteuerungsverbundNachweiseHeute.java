package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der Stand der Naht {@link SteuerungsverbundNachweise} in IP-5: die Fähigkeit fragt {@link BoxFaehigkeiten#kann}
 * (das Wort kennt sie erst mit IP-17 — bis dahin nein), alles andere hat noch keine Quelle und fehlt. Damit wird keine
 * Anlage scharf, bevor die Pakete ihre Quellen liefern.
 */
@Component
public class SteuerungsverbundNachweiseHeute implements SteuerungsverbundNachweise {

    private final BoxFaehigkeiten faehigkeiten;
    private final SteuerungsverbundAnteilDienst anteile;

    public SteuerungsverbundNachweiseHeute(BoxFaehigkeiten faehigkeiten, SteuerungsverbundAnteilDienst anteile) {
        this.faehigkeiten = faehigkeiten;
        this.anteile = anteile;
    }

    @Override
    public boolean faehigkeit(UUID box) {
        return faehigkeiten.kann(box, FAEHIGKEIT);
    }

    /** IP-21 baut die Sprungprobe. */
    @Override
    public boolean sprungprobe(UUID verbundId, UUID box) {
        return false;
    }

    /**
     * IP-7: der Eingang aus Geräten je Box (Nennleistung, Schreibfreigabe), ihren Rückfällen (IP-6), der wirksamen
     * Grenze und dem gespeicherten Vorbehalt ({@link SteuerungsverbundAnteilDienst#auslegungFuer}); leer, solange eine
     * Richtung nicht rechenbar ist.
     */
    @Override
    public Optional<Map<Grenzart, SteuerungsverbundRegeln.Richtung>> auslegung(UUID siteId, List<UUID> boxen,
            LocalDate tag) {
        return anteile.auslegungFuer(siteId, boxen, tag);
    }

    @Override
    public Boolean verbraucher14a(UUID siteId, UUID box) {
        return null;
    }

    @Override
    public Boolean vorgabeSignal(UUID siteId, UUID box) {
        return null;
    }
}
