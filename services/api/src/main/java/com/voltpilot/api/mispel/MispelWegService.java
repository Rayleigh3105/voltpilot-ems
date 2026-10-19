package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Angaben;
import com.voltpilot.api.mispel.MispelWegRegeln.Eingang;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import com.voltpilot.api.uems.ZaehlerrolleRegeln.Knoten;
import com.voltpilot.api.uems.ZaehlerrolleService;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * „Der Weg zu MiSpeL“ je Anlage (MiSpeL MP-55, Vertrag {@code docs/contracts/v2/mispel-weg.md}): liest unter RLS, was
 * die Anlage in den MiSpeL-Quellen hat, und gibt es an {@link MispelWegRegeln}. Keine eigene Tabelle, kein Schreibweg.
 *
 * <p>Quellen: der Check ({@code site_mispel_check}, {@link MispelCheckRepository}), der Förderweg mit Vormerkung,
 * Einverständnis und Partner ({@code site_foerderweg}, {@link FoerderwegService}), die Vormerkung der Pauschaloption
 * ({@code site_pauschal_vormerkung}, {@link PauschalVormerkungService}), die Zählerrollen des Messstellen-Registers mit
 * ihrem Urteil ({@link ZaehlerrolleService}), die Ladepunkte ({@link LadepunktService}) sowie Speicher, Profil und der
 * jüngste Monats- und Jahreslauf ({@link MispelWegRepository}). Ein Tag für alle: heute nach der Uhr des Förderwegs.
 */
@Service
public class MispelWegService {

    private final MispelCheckRepository checks;
    private final FoerderwegService foerderwege;
    private final PauschalVormerkungService pauschal;
    private final ZaehlerrolleService zaehlerrollen;
    private final LadepunktService ladepunkte;
    private final MispelWegRepository weg;

    public MispelWegService(MispelCheckRepository checks, FoerderwegService foerderwege,
            PauschalVormerkungService pauschal, ZaehlerrolleService zaehlerrollen, LadepunktService ladepunkte,
            MispelWegRepository weg) {
        this.checks = checks;
        this.foerderwege = foerderwege;
        this.pauschal = pauschal;
        this.zaehlerrollen = zaehlerrollen;
        this.ladepunkte = ladepunkte;
        this.weg = weg;
    }

    /** Gibt es die Anlage im Kundenbereich (RLS)? Eine fremde oder unbekannte ist unsichtbar. */
    public boolean anlageSichtbar(UUID siteId) {
        return checks.anlageSichtbar(siteId);
    }

    /** Was die Regeln lesen — für eine sichtbare Anlage. */
    public Eingang eingang(UUID siteId) {
        LocalDate heute = foerderwege.heute();
        FoerderwegService.Ansicht f = foerderwege.ansicht(siteId, heute);
        MispelWegRegeln.Weg wegHeute = f == null || f.angaben() == null ? null
                : weg(f.angaben(), f.fassung() == null ? null : f.fassung().gueltigAb());
        MispelWegRegeln.Weg vormerkung = f == null || f.vormerkung() == null ? null
                : weg(f.vormerkung().angaben(), f.vormerkung().gueltigAb());
        MispelWegRegeln.Check check = checks.derAnlage(siteId)
                .map(z -> new MispelWegRegeln.Check(z.stand(), z.formelsatz(), z.differenzMittelEur(), z.hinweis()))
                .orElse(null);
        MispelWegRegeln.Vormerkung pv = pauschal.aktuelle(siteId)
                .map(v -> new MispelWegRegeln.Vormerkung(v.steckersolarKwp(), v.einBetreiberBestaetigtAm() != null,
                        v.steckersolarDvBestaetigtAm() != null, v.direktvermarkter(), v.bilanzkreisGesondert()))
                .orElse(null);
        return new Eingang(heute, weg.speicher(siteId), weg.profil(siteId), check, wegHeute, vormerkung, pv,
                pauschal.solarleistungImAufbau(siteId), pauschal.pauschaloptionAb(), zaehler(siteId, heute),
                weg.juengsterMonat(siteId).orElse(null), weg.juengstesJahr(siteId).orElse(null),
                ladepunkte(siteId, heute));
    }

    private static MispelWegRegeln.Weg weg(Angaben a, LocalDate gueltigAb) {
        return new MispelWegRegeln.Weg(a.foerderweg().wert(), a.formelsatz(), a.einverstaendnis(), a.direktvermarkter(),
                a.bilanzkreisGesondert(), gueltigAb);
    }

    /** Jede Messstelle der Anlage mit Rolle am Tag, mit dem Urteil, das auch die Messstelle zeigt. */
    private List<MispelWegRegeln.Zaehler> zaehler(UUID siteId, LocalDate heute) {
        ZaehlerrolleService.AnlageStand stand = zaehlerrollen.anlage(siteId, heute);
        List<MispelWegRegeln.Zaehler> out = new ArrayList<>();
        for (Knoten k : stand.knoten()) {
            String rolle = k.angaben() == null ? null : k.angaben().rolle();
            if (rolle != null) {
                out.add(new MispelWegRegeln.Zaehler(k.kennzeichen(), rolle, ZaehlerrolleRegeln.urteil(rolle,
                        ZaehlerrolleRegeln.befundeZu(k.kennzeichen(), stand.befunde()))));
            }
        }
        return List.copyOf(out);
    }

    private List<MispelWegRegeln.Ladepunkt> ladepunkte(UUID siteId, LocalDate heute) {
        List<MispelWegRegeln.Ladepunkt> out = new ArrayList<>();
        for (LadepunktService.Ansicht a : ladepunkte.anlage(siteId, heute)) {
            LadepunktRegeln.Fahrzeugfenster fenster = a.fahrzeugfenster() == null ? null : a.fahrzeugfenster().fenster();
            String rueckspeisen = a.fahrer() != null && a.fahrer().erfasst() ? a.fahrer().rueckspeisen() : null;
            out.add(new MispelWegRegeln.Ladepunkt(a.komponente().id(), a.komponente().label(),
                    a.faehigkeit().bidirektional(), a.z2().stream().map(LadepunktRegeln.Z2::urteil).toList(),
                    fenster == null ? null : fenster.mindestSocPct(),
                    fenster == null || fenster.anwesenheit() == null ? List.of() : fenster.anwesenheit(), rueckspeisen));
        }
        return List.copyOf(out);
    }
}
