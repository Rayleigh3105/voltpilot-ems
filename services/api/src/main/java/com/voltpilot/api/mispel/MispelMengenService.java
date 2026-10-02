package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import com.voltpilot.api.repo.MispelMarktdatenRepository;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Liest die Kundenansicht der Abgrenzungsoption (MP-18) aus den gespeicherten Läufen (MP-8, MP-21) — dieselbe Auswahl
 * der geltenden Läufe wie der Nachweis (MP-16) — und bewertet sie mit dem Preisblatt der Anlage und dem
 * Jahresmarktwert (MP-7, MP-12). Rechnet keine Menge selbst; siehe {@link MispelMengen}.
 */
@Service
public class MispelMengenService {

    /** Der Energieträger, dessen Jahresmarktwert die Marktprämie bestimmt — derselbe wie in den Erlösen (MP-12, W3). */
    static final String TECHNOLOGIE = "solar";

    /**
     * Ein Kalendermonat: Förderweg am Monatsersten, ob er nach Anlage 1 bestimmt wird, Stand, Teile und Wert. Ohne Lauf
     * sind {@code stand} und {@code wert} {@code null} — noch nicht bestimmt, nie 0.
     */
    public record Monat(String monat, String foerderweg, String foerderwegBegriff, boolean mispel, boolean abgrenzung,
            String stand, List<String> gruende, boolean giltAlsNachweis, List<MispelMengen.Teil> teile,
            MispelMengen.Wert wert) {}

    /** Das Kalenderjahr: eine Zeile je Monat, Wert über alle Teile, Frist der Mitteilung des Lieferanten. */
    public record Jahr(int jahr, boolean mispel, boolean abgrenzung, String stand, List<String> gruende,
            boolean giltAlsNachweis, List<Monat> monate, MispelMengen.Wert wert, LocalDate mitteilungBis) {}

    private final MispelAbgrenzungRepository laeufe;
    private final FoerderwegService wege;
    private final MispelMarktdatenRepository markt;
    private final JdbcTemplate jdbc;

    public MispelMengenService(MispelAbgrenzungRepository laeufe, FoerderwegService wege,
            MispelMarktdatenRepository markt, JdbcTemplate jdbc) {
        this.laeufe = laeufe;
        this.wege = wege;
        this.markt = markt;
        this.jdbc = jdbc;
    }

    /** {@code null} für eine fremde oder unbekannte Anlage. */
    public Monat monat(UUID siteId, YearMonth monat) {
        pruefen(monat);
        MispelMengen.Preise preise = preise(siteId);
        if (preise == null) {
            return null;
        }
        return monat(siteId, monat, preise, marktwert(siteId, monat.getYear()));
    }

    /** {@code null} für eine fremde oder unbekannte Anlage. */
    public Jahr jahr(UUID siteId, int jahr) {
        if (jahr < MispelNachweisService.AB.getYear() || jahr > 9999) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab "
                    + MispelNachweisService.AB + ".");
        }
        MispelMengen.Preise preise = preise(siteId);
        if (preise == null) {
            return null;
        }
        MispelMengen.Marktwert mw = marktwert(siteId, jahr);
        List<Monat> monate = new ArrayList<>();
        List<MispelMengen.Teil> alle = new ArrayList<>();
        for (int m = 1; m <= 12; m++) {
            YearMonth ym = YearMonth.of(jahr, m);
            if (ym.isBefore(MispelNachweisService.AB)) {
                continue;
            }
            Monat mo = monat(siteId, ym, preise, mw);
            monate.add(mo);
            alle.addAll(mo.teile());
        }
        boolean mispel = monate.stream().anyMatch(Monat::mispel);
        boolean abgrenzung = monate.stream().anyMatch(Monat::abgrenzung);
        String stand = null;
        List<String> gruende = List.of();
        boolean gilt = false;
        if (!alle.isEmpty()) {
            MispelNachweis.Jahr j = MispelNachweis.jahr(siteId, jahr, laeufe.desJahres(siteId, jahr));
            stand = j.stand();
            gruende = j.gruende();
            gilt = j.giltAlsNachweis();
        }
        return new Jahr(jahr, mispel, abgrenzung, stand, gruende, gilt, List.copyOf(monate),
                alle.isEmpty() ? null : MispelMengen.wert(alle, preise, mw), LocalDate.of(jahr + 1, 5, 31));
    }

    private Monat monat(UUID siteId, YearMonth monat, MispelMengen.Preise preise, MispelMengen.Marktwert mw) {
        FoerderwegService.Ansicht am = wege.ansicht(siteId, monat.atDay(1));
        Foerderweg weg = am == null || am.angaben() == null ? null : am.angaben().foerderweg();
        boolean mispel = weg != null && weg.mispel();
        boolean abgrenzung = weg == Foerderweg.MARKTPRAEMIE_ABGRENZUNG;
        if (am != null) {
            for (FoerderwegService.FassungAnsicht f : am.fassungen()) {
                Foerderweg w = f.fassung().angaben().foerderweg();
                boolean imMonat = !f.fassung().aufgehoben() && !f.fassung().gueltigAb().isAfter(monat.atEndOfMonth())
                        && (f.gueltigBis() == null || !f.gueltigBis().isBefore(monat.atDay(1)));
                mispel |= imMonat && w.mispel();
                abgrenzung |= imMonat && w == Foerderweg.MARKTPRAEMIE_ABGRENZUNG;
            }
        }
        List<Zeile> zeilen = laeufe.desMonats(siteId, monat.atDay(1));
        if (zeilen.isEmpty()) {
            return new Monat(monat.toString(), weg == null ? null : weg.wert(), weg == null ? null : weg.begriff(),
                    mispel, abgrenzung, null, List.of(), false, List.of(), null);
        }
        MispelNachweis.Monat n = MispelNachweis.monat(siteId, monat, zeilen);
        List<MispelMengen.Teil> teile = MispelMengen.teile(n.laeufe(), zeilen, preise);
        return new Monat(monat.toString(), weg == null ? null : weg.wert(), weg == null ? null : weg.begriff(),
                true, true, n.stand(), n.gruende(), n.giltAlsNachweis(), teile, MispelMengen.wert(teile, preise, mw));
    }

    private static void pruefen(YearMonth monat) {
        if (monat.isBefore(MispelNachweisService.AB)) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab "
                    + MispelNachweisService.AB + ".");
        }
    }

    /**
     * Das Preisblatt der Anlage ({@code site_supply_price}, ct/kWh netto, MP „Bezugspreis-Komponenten“); ohne Zeile
     * sind die Sätze {@code null} und die Beträge {@code offen}. {@code null} = die Anlage ist nicht sichtbar (RLS).
     */
    private MispelMengen.Preise preise(UUID siteId) {
        return jdbc.query("SELECT ssp.umlagen_ct, ssp.netzentgelt_arbeitspreis_ct, ssp.ust_pct FROM site s "
                        + "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id WHERE s.id = ?",
                rs -> rs.next() ? new MispelMengen.Preise(rs.getBigDecimal(1), rs.getBigDecimal(2),
                        rs.getBigDecimal(3)) : null,
                siteId);
    }

    /** AW der Anlage ({@code site.anzulegender_wert_ct_kwh}) und der Jahresmarktwert Solar des Jahres. */
    private MispelMengen.Marktwert marktwert(UUID siteId, int jahr) {
        BigDecimal aw = jdbc.query("SELECT anzulegender_wert_ct_kwh FROM site WHERE id = ?",
                rs -> rs.next() ? rs.getBigDecimal(1) : null, siteId);
        return markt.jahresmarktwert(jahr, TECHNOLOGIE)
                .map(j -> new MispelMengen.Marktwert(aw, j.ctKwh(), j.vorlaeufig()))
                .orElse(new MispelMengen.Marktwert(aw, null, false));
    }
}
