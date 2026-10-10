package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Vorschau und Bestätigung der Standort-Zuordnung für Bestandsanlagen (AP-02 IP-10). */
public final class StandortVorschlagDto {
    private StandortVorschlagDto() {}

    public record Anlage(UUID vorschlagId, UUID anlageId, String anlageName, LocalDate gueltigAb) {}

    /** Eine vorgeschlagene Zusammenlegen-Gruppe; beim Lesen zunächst eine je Anlage. */
    public record Gruppe(String name, String zeitzone, Adresse adresse, List<Anlage> anlagen) {}

    public record Vorschau(List<Gruppe> gruppen, int anlagenZahl) {}

    public record Bestaetigen(List<GruppeEingang> gruppen) {}

    public record GruppeEingang(String name, String zeitzone, Adresse adresse, List<UUID> vorschlagIds) {}

    public record Ergebnis(List<UUID> standortIds, int zuordnungen) {}
}
