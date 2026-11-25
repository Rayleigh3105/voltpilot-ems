package com.voltpilot.api.web.dto;

import com.voltpilot.api.direktvermarktung.DirektvermarktungService.Status;
import com.voltpilot.api.direktvermarktung.PartnerProfil;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.ProtokollZeile;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Antwort der Direktvermarktung-Routen (Einstellungen › Strom &amp; Geld, Seite
 * {@code #/anlage/{id}/direktvermarktung}, Konzept vp-direktvermarktung-konzept d2 §7). {@code darf} entscheidet,
 * ob das Portal den Hauptknopf zeigt (Muster {@code SiteSteuerwegController.Antwort}).
 *
 * <p>Fehlt ein Teil - keine {@code stand}-Zeile, kein {@code geplant} - heißt das "unbekannt"/"nichts geplant", nie
 * eine erfundene Null (Konzept §5.1).
 */
public record DirektvermarktungDto(EintragDto aktuell, EintragDto geplant, PartnerDto partner,
        PartnerDto geplanterPartner, StandDto stand, List<ProtokollZeileDto> verlaufKurz, List<PartnerDto> katalog,
        boolean darf) {

    public record PartnerDto(String partner, String name, String vertragLink) {

        public static PartnerDto von(PartnerProfil p) {
            if (p == null) return null;
            return new PartnerDto(p.partner(), p.anzeigename(), p.vertrag() == null ? null : p.vertrag().link());
        }
    }

    public record EintragDto(UUID id, String partner, String zustand, Instant zustimmungAm, String zustimmungVon,
            LocalDate startdatum, LocalDate ende, int revision) {

        public static EintragDto von(Eintrag e) {
            if (e == null) return null;
            return new EintragDto(e.id(), e.partner(), e.zustand(), e.zustimmungAm(), e.zustimmungVon(),
                    e.startdatum(), e.ende(), e.revision());
        }
    }

    public record StandDto(Instant tunnelObenSeit, Instant handshakeAm, String gegenstelle, Instant letzteAbfrageAm,
            Double abfragenJeMinute, Instant letzteSchreibungAm, Integer vorgabePct, Instant lebenszeichenAm,
            Integer einspeisungW, Integer erzeugungW, Integer netzbetreiberPct, Integer referenzW) {

        public static StandDto von(Stand s) {
            if (s == null) return null;
            return new StandDto(s.tunnelObenSeit(), s.handshakeAm(), s.gegenstelle(), s.letzteAbfrageAm(),
                    s.abfragenJeMinute(), s.letzteSchreibungAm(), s.vorgabePct(), s.lebenszeichenAm(),
                    s.einspeisungW(), s.erzeugungW(), s.netzbetreiberPct(), s.referenzW());
        }
    }

    public record ProtokollZeileDto(long id, String ereignis, String von, String rolle, Instant am) {

        public static ProtokollZeileDto von(ProtokollZeile z) {
            return new ProtokollZeileDto(z.id(), z.ereignis(), z.von(), z.rolle(), z.am());
        }
    }

    public static DirektvermarktungDto von(Status s, boolean darf) {
        return new DirektvermarktungDto(EintragDto.von(s.aktuell()), EintragDto.von(s.geplant()),
                PartnerDto.von(s.partner()), PartnerDto.von(s.geplanterPartner()), StandDto.von(s.stand()),
                s.verlaufKurz().stream().map(ProtokollZeileDto::von).toList(),
                s.katalog().stream().map(PartnerDto::von).toList(), darf);
    }
}
