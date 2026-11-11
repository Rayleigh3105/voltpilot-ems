package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.uems.MessstelleRegisterService;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.time.Instant;
import java.time.YearMonth;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der {@code zaehlung}-Leser (Alerting Scheibe 5, Konzept §6.3): die Messstelle - Menge je Monat,
 * Beobachtung ("liefert"/"liefert nicht seit"/…) und "Monat unvollständig" - DIESELBEN Zahlen wie
 * die Messstellen-Seite ({@link MessstelleWerteService#monatswert}, {@link MessstelleRegisterService#liste}),
 * nie eine eigene Berechnung. Ein eigener Leser statt einer Erweiterung von {@code menge}/{@code zustand}
 * (Hausregel "additiv"): eine Messstelle hat ein anderes Standort-/Rechte-Modell als eine Anlage und
 * berührt so keinen bestehenden, ab Werk gesäten Eintrag.
 *
 * <p><b>"Monat unvollständig" meldet am Tag nach Monatsende, nicht früher, nicht dauernd</b> (§6.4,
 * §7 Scheibe 5 Punkt 5): dieser Leser liest IMMER die zuletzt VOLLSTÄNDIG abgeschlossene Periode
 * ({@link PeriodenFenster#vorige}) - ihr Zustand kann sich darum frühestens am Tag wechseln, an dem
 * ein neuer Monat abschließt, und er erledigt sich von selbst, sobald die fehlende Ablesung/der
 * fehlende Wert nachträgt (kein eigener Fristenzähler nötig).
 *
 * <p><b>Entscheid 9A:</b> kein Eintrag dieses Lesers trägt einen Vorschlag ab Werk
 * ({@code wertekatalog/katalog.json}) - nur eine selbst angelegte Überwachung liest ihn
 * ({@link UeberwachungAnlegenService}).
 */
@Component
public class ZaehlungWerteLeser implements WerteLeser {

    static final String FELD_MENGE_MONAT = "menge_monat";
    static final String FELD_BEOBACHTUNG = "beobachtung";
    static final String FELD_MONAT_VOLLSTAENDIGKEIT = "monat_vollstaendigkeit";

    private final MessstelleRepository messstellen;
    private final MessstelleWerteService werte;
    private final MessstelleRegisterService register;

    public ZaehlungWerteLeser(MessstelleRepository messstellen, MessstelleWerteService werte,
            MessstelleRegisterService register) {
        this.messstellen = messstellen;
        this.werte = werte;
        this.register = register;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"messstelle".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        String feld = eintrag.leser().feld();
        if (FELD_MENGE_MONAT.equals(feld)) {
            return lesePeriode(eintrag, bezug, "monat", false, jetzt);
        }
        if (FELD_BEOBACHTUNG.equals(feld)) {
            return beobachtung(bezug.id(), jetzt);
        }
        if (FELD_MONAT_VOLLSTAENDIGKEIT.equals(feld)) {
            return monatVollstaendigkeit(bezug.id(), jetzt);
        }
        throw new IllegalArgumentException("ZaehlungWerteLeser: unbekanntes Feld '" + feld + "'");
    }

    @Override
    public Lesung lesePeriode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, boolean nurEndgueltig,
            Instant jetzt) {
        if (!FELD_MENGE_MONAT.equals(eintrag.leser().feld())) {
            return lese(eintrag, bezug, jetzt); // beobachtung/monat_vollstaendigkeit sind periodenunabhängig
        }
        if (!"messstelle".equals(bezug.art()) || !"monat".equals(periode)) {
            return Lesung.unbekannt(); // Messstellen-Werte kennt nur das Monatsraster (§6.3)
        }
        PeriodenFenster.Fenster fenster = PeriodenFenster.aktuelle(periode, jetzt, "monat");
        if (nurEndgueltig && !fenster.abgeschlossen(jetzt)) {
            return Lesung.unbekannt(); // §6.3 "vorläufig oder erst endgültig"
        }
        return mengeMonat(bezug.id(), YearMonth.from(fenster.von().atZone(HistoryRange.ZONE)), jetzt);
    }

    @Override
    public Lesung leseVorperiode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, Instant jetzt) {
        if (!FELD_MENGE_MONAT.equals(eintrag.leser().feld()) || !"messstelle".equals(bezug.art())
                || !"monat".equals(periode)) {
            return Lesung.unbekannt();
        }
        PeriodenFenster.Fenster vorige = PeriodenFenster.vorige(periode, jetzt, "monat");
        return mengeMonat(bezug.id(), YearMonth.from(vorige.von().atZone(HistoryRange.ZONE)), jetzt);
    }

    /** Die Menge des Monats - dieselbe Zahl wie {@code GET …/messstellen/{kennzeichen}/werte?raster=monat}. */
    private Lesung mengeMonat(UUID messstelleId, YearMonth monat, Instant jetzt) {
        Optional<MessstelleRepository.Messstelle> m = messstellen.finde(messstelleId);
        if (m.isEmpty()) {
            return Lesung.unbekannt();
        }
        MessstelleWerteDto.Wert wert = monatswert(m.get(), monat);
        if (wert == null || wert.menge() == null) {
            return Lesung.unbekannt();
        }
        String einheit = m.get().hauptgroesse() == null ? null : m.get().hauptgroesse().einheit();
        return Lesung.zahl(wert.menge().doubleValue(), einheit, jetzt);
    }

    /**
     * "Monat unvollständig" (§7 Scheibe 5 Punkt 5): der Zustand ({@code vollstaendig}/{@code unvollstaendig})
     * des zuletzt ABGESCHLOSSENEN Monats - dieselbe Zahl wie die Messstellen-Seite, nie früher als der
     * Tag nach Monatsende gelesen (siehe Klassenkommentar).
     */
    private Lesung monatVollstaendigkeit(UUID messstelleId, Instant jetzt) {
        Optional<MessstelleRepository.Messstelle> m = messstellen.finde(messstelleId);
        if (m.isEmpty()) {
            return Lesung.unbekannt();
        }
        PeriodenFenster.Fenster vorige = PeriodenFenster.vorige("monat", jetzt, "monat");
        YearMonth monat = YearMonth.from(vorige.von().atZone(HistoryRange.ZONE));
        MessstelleWerteDto.Wert wert = monatswert(m.get(), monat);
        return wert == null || wert.zustand() == null ? Lesung.unbekannt() : Lesung.zustand(wert.zustand(), jetzt);
    }

    private MessstelleWerteDto.Wert monatswert(MessstelleRepository.Messstelle m, YearMonth monat) {
        MessstelleWerteService.Monatswert mw = werte.monatswert(m, monat, (ms, von, bis) -> true);
        return mw == null ? null : mw.wert();
    }

    /** Die Beobachtung der Hauptgröße - dieselben vier Zustandswörter wie die Messstellen-Seite. */
    private Lesung beobachtung(UUID messstelleId, Instant jetzt) {
        MessstelleDto.Liste liste = register.liste(jetzt, MessstelleRegisterService.Filter.KEINER);
        return liste.register().stream()
                .filter(z -> messstelleId.equals(z.id()))
                .findFirst()
                .map(MessstelleDto.RegisterZeile::beobachtung)
                .filter(b -> b.zustand() != null)
                .map(b -> Lesung.zustand(b.zustand(), jetzt))
                .orElse(Lesung.unbekannt());
    }
}
