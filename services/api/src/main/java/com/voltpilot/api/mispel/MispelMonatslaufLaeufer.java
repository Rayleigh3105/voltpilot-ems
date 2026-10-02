package com.voltpilot.api.mispel;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.mispel.FoerderwegRegeln.Angaben;
import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import com.voltpilot.api.mispel.FoerderwegRepository.Fassung;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Fallstand;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * MiSpeL MP-8b: stößt den Monatslauf der Abgrenzungsoption ({@link MispelAbgrenzungService#monatslaeufe}, MP-8/MP-21)
 * je Anlage selbst an. „Die konkrete Bestimmung der umlage- und förderrelevanten Strommengen erfolgt im ersten Schritt
 * für den jeweiligen Kalendermonat. Sobald die erforderlichen viertelstündlich erfassten Messwerte zum abgelaufenen
 * Kalendermonat feststehen, lassen sich die relevanten Werte für den jeweiligen Kalendermonat nach dem Formelsatz zu
 * der jeweiligen Fallkonstellation bestimmen“ (Anlage 1 S. 14, Abschn. 2.1.4). Darum:
 * <ul>
 *   <li><b>nach Ablauf des Kalendermonats</b> der erste Lauf — auf Gerätewerten ist er {@code vorlaeufig}
 *       (Entscheid E4 = C, Bauplan § 8.5);</li>
 *   <li>ein vorläufiger Monat wird in jedem Takt neu gerechnet; sind die Werte des Messstellenbetreibers eingelesen
 *       (MP-15), wird er {@code endgueltig} (Tenor S. 28; § 21 Abs. 4 S. 2 EnFG);</li>
 *   <li>ein endgültiger Monat nur, wenn danach neue Werte des Messstellenbetreibers oder eine neue Fassung des
 *       Förderwegs kamen.</li>
 * </ul>
 * Formelsatz und AW-Regel kommen aus der Fassung des Förderwegs ({@code site_foerderweg}, MP-5/MP-17), die an dem
 * jeweiligen Tag gilt — eine zum Monatsersten vorgemerkte also ab ihrem Monat. Jede Fassung ist ein Fallstand; der
 * Monat teilt sich an bestimmungsrelevanten Änderungen in Rumpfmonate (MP-21, A1 S. 102–104, Abschn. 11). Ein Wechsel
 * der Zuordnung geht nur zum Monatsersten (A1 S. 103; § 21b Abs. 1 S. 2 EEG); nur die erstmalige Zuordnung darf im
 * Monat beginnen.
 *
 * <p><b>Welche Monate:</b> ab dem Monat der Festlegung ({@link FoerderwegRegeln#FESTLEGUNG_AB}) die des laufenden
 * Kalenderjahres und — bis zur Mitteilung bis 31.05. des Folgejahres (§ 21 Abs. 7 EnFG) — die des Vorjahres; die
 * Monatswerte werden für die Endabrechnung des Kalenderjahres aufsummiert (A1 S. 14). Ein früherer Monat bleibt, wie
 * er gespeichert ist.
 *
 * <p><b>Nicht bestimmbar aus dem Förderweg</b> (übersprungen, nie geraten): A5/A5-Variante brauchen Painst/Pbinst und
 * die AW-Regel der Anlage b (A1 S. 46, Formeln (24a)/(24b)), die der Förderweg nicht trägt; A1–A4 ohne eingetragene
 * {@code aw_regel} haben keine Liste der ÜNB (A1 S. 17 Fn. 8). Lehnt das Rechenwerk einen Monat ab
 * ({@link MispelAbgrenzungAbgelehnt}, etwa ein fehlender Zähler), bleibt er ohne Lauf; das ist kein Fehler des Läufers.
 *
 * <p>Idempotent: ein Lauf mit gleicher Prüfsumme hängt keine Fassung an. Ein Fehler bei einer Anlage oder einem
 * Monat hält die anderen nicht auf und zählt beim {@link UemsLaeuferMelder}. <b>⚠ Wie jeder {@code @Scheduled} ist er
 * im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN ({@code application.yml},
 * {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf()} selbst. Er wirft nie.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.mispel.monatslauf.enabled", havingValue = "true", matchIfMissing = true)
public class MispelMonatslaufLaeufer {

    private static final Logger log = LoggerFactory.getLogger(MispelMonatslaufLaeufer.class);

    /**
     * Was ein Takt getan hat, je Anlage und Kalendermonat: {@code neu} = mindestens eine Fassung angehängt,
     * {@code unveraendert} = gerechnet ohne neue Fassung, {@code endgueltig} = nicht fällig, {@code uebersprungen} =
     * aus dem Förderweg nicht bestimmbar, {@code abgelehnt} = vom Rechenwerk abgelehnt, {@code gescheitert} = Fehler.
     */
    public record Ergebnis(int anlagen, int neu, int unveraendert, int endgueltig, int uebersprungen, int abgelehnt,
            int gescheitert) {}

    private final JdbcTemplate adminJdbc;
    private final MispelMonatslaufRepository anlagen;
    private final FoerderwegRepository wege;
    private final MispelAbgrenzungService dienst;
    private final MispelAbgrenzungRepository laeufe;
    private Clock uhr = Clock.systemUTC();

    /** Der Betriebs-Melder (Läufer {@code mispel_monatslauf}); ohne Spring der stumme. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public MispelMonatslaufLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MispelMonatslaufRepository anlagen, FoerderwegRepository wege, MispelAbgrenzungService dienst,
            MispelAbgrenzungRepository laeufe) {
        this.adminJdbc = adminJdbc;
        this.anlagen = anlagen;
        this.wege = wege;
        this.dienst = dienst;
        this.laeufe = laeufe;
    }

    /** Nur für Tests: die Uhr, an der „Monat abgelaufen“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    @Scheduled(cron = "${voltpilot.mispel.monatslauf.cron:0 17 5 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            Ergebnis e = lauf();
            melder.gelaufen(UemsLaeuferMelder.MISPEL_MONATSLAUF);
            if (e.neu() + e.abgelehnt() + e.gescheitert() > 0) {
                log.info("MiSpeL-Monatslauf: {}", e);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.MISPEL_MONATSLAUF);
            log.warn("MiSpeL-Monatslauf übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche und ihre Anlagen in der Abgrenzungsoption. Wirft nie je Anlage. */
    public Ergebnis lauf() {
        List<YearMonth> monate = monate(LocalDate.now(uhr.withZone(MispelAbgrenzungRechenwerk.BERLIN)));
        int[] n = new int[7];
        if (monate.isEmpty()) {
            return ergebnis(n);
        }
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : anlagen.anlagenMitAbgrenzung()) {
                    n[0]++;
                    try {
                        anlage(anlage, monate, n);
                    } catch (RuntimeException e) {
                        n[6]++;
                        melder.fehler(UemsLaeuferMelder.MISPEL_MONATSLAUF);
                        log.warn("MiSpeL-Monatslauf für Anlage {} gescheitert: {}", anlage, e.toString());
                    }
                }
            } catch (RuntimeException e) {
                n[6]++;
                melder.fehler(UemsLaeuferMelder.MISPEL_MONATSLAUF);
                log.warn("MiSpeL-Monatslauf für Kundenbereich {} gescheitert: {}", tenant, e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return ergebnis(n);
    }

    private void anlage(UUID anlage, List<YearMonth> monate, int[] n) {
        List<Fassung> fassungen = wege.derAnlage(anlage);
        List<Fallstand> faelle = fallstaende(fassungen);
        for (YearMonth monat : monate) {
            List<Fallstand> imMonat = imMonat(faelle, monat);
            if (imMonat.stream().noneMatch(f -> f.vorgaben() != null)) {
                continue; // kein Tag in der Abgrenzungsoption: keine Bestimmung nach Anlage 1
            }
            try {
                Optional<String> grund = nichtBestimmbar(imMonat);
                if (grund.isPresent()) {
                    n[4]++;
                    log.debug("MiSpeL-Monatslauf {} {}: {}", anlage, monat, grund.get());
                    continue;
                }
                MispelRumpfmonate.Teilung t = dienst.teilung(anlage, monat, faelle);
                if (t.rumpfmonate().isEmpty()) {
                    continue;
                }
                if (!faellig(anlage, t, fassungen)) {
                    n[3]++;
                    continue;
                }
                List<Lauf> l = dienst.monatslaeufe(anlage, monat, faelle);
                n[l.stream().anyMatch(Lauf::neu) ? 1 : 2]++;
            } catch (MispelAbgrenzungAbgelehnt e) {
                n[5]++;
                log.info("MiSpeL-Monatslauf {} {} abgelehnt: {}", anlage, monat, e.getMessage());
            } catch (RuntimeException e) {
                n[6]++;
                melder.fehler(UemsLaeuferMelder.MISPEL_MONATSLAUF);
                log.warn("MiSpeL-Monatslauf {} {} gescheitert: {}", anlage, monat, e.toString());
            }
        }
    }

    /**
     * Fällig ist ein Monat, wenn ein Teil noch keinen Lauf hat, sein jüngster Lauf vorläufig ist, oder nach dem Lauf
     * Werte des Messstellenbetreibers für den Zeitraum oder eine Fassung des Förderwegs eingetragen bzw. aufgehoben
     * wurden.
     */
    private boolean faellig(UUID anlage, MispelRumpfmonate.Teilung t, List<Fassung> fassungen) {
        LocalDate monatsende = t.monat().plusMonths(1).atDay(1);
        for (MispelRumpfmonate.Rumpfmonat r : t.rumpfmonate()) {
            Instant von = r.von().atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
            Instant bis = r.bis().atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant();
            Optional<Zeile> letzte = laeufe.letzte(anlage, von);
            if (letzte.isEmpty() || !MispelAbgrenzungService.ENDGUELTIG.equals(letzte.get().stand())) {
                return true;
            }
            Instant am = letzte.get().gerechnetAm();
            boolean foerderwegNeu = fassungen.stream().filter(f -> f.gueltigAb().isBefore(monatsende))
                    .anyMatch(f -> f.eingetragenAm().isAfter(am) || f.aufgehoben() && f.aufgehobenAm().isAfter(am));
            if (foerderwegNeu || anlagen.msbWerteSeit(anlage, von, bis, am)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Die Monate des Laufs am Tag {@code heute}: abgelaufen, ab der Festlegung, im laufenden Kalenderjahr und bis zum
     * 31.05. auch im Vorjahr (§ 21 Abs. 7 EnFG).
     */
    static List<YearMonth> monate(LocalDate heute) {
        int abJahr = heute.isAfter(LocalDate.of(heute.getYear(), 5, 31)) ? heute.getYear() : heute.getYear() - 1;
        YearMonth erster = YearMonth.of(abJahr, 1);
        YearMonth festlegung = YearMonth.from(FoerderwegRegeln.FESTLEGUNG_AB);
        if (erster.isBefore(festlegung)) {
            erster = festlegung;
        }
        List<YearMonth> out = new ArrayList<>();
        for (YearMonth m = erster; m.isBefore(YearMonth.from(heute)); m = m.plusMonths(1)) {
            out.add(m);
        }
        return out;
    }

    /**
     * Je wirksame Fassung ein Fallstand ab ihrem Tag: in der Abgrenzungsoption mit Formelsatz und AW-Regel der
     * Fassung, sonst ohne Vorgaben (keine Bestimmung nach Anlage 1). Wechselt der Förderweg, ist das die erstmalige
     * Zuordnung, wenn vorher keine Fassung stand und der Tag kein Monatserster ist, sonst ein Wechsel der Zuordnung
     * (A1 S. 103) — den {@link MispelRumpfmonate#teilen} im Monat ablehnt.
     */
    static List<Fallstand> fallstaende(List<Fassung> fassungen) {
        List<Fassung> wirksam = fassungen.stream().filter(f -> !f.aufgehoben())
                .sorted(Comparator.comparing(Fassung::gueltigAb)).toList();
        List<Fallstand> out = new ArrayList<>();
        Foerderweg vorher = null;
        for (Fassung f : wirksam) {
            Angaben a = f.angaben();
            String anlass = null;
            if (a.foerderweg() != vorher) {
                anlass = vorher == null && f.gueltigAb().getDayOfMonth() != 1 ? "erstmalige_zuordnung"
                        : "wechsel_zuordnung";
            }
            boolean abgrenzung = a.foerderweg() == Foerderweg.MARKTPRAEMIE_ABGRENZUNG;
            out.add(new Fallstand(f.gueltigAb(), anlass, abgrenzung ? a.formelsatz() : null,
                    abgrenzung ? Vorgaben.von(a.formelsatz(), a.awRegel()) : null));
            vorher = a.foerderweg();
        }
        return List.copyOf(out);
    }

    /** Die Fallstände, die an mindestens einem Tag des Monats gelten. */
    private static List<Fallstand> imMonat(List<Fallstand> faelle, YearMonth monat) {
        LocalDate erster = monat.atDay(1);
        LocalDate ende = monat.plusMonths(1).atDay(1);
        List<Fallstand> out = new ArrayList<>();
        for (int i = 0; i < faelle.size(); i++) {
            Fallstand f = faelle.get(i);
            LocalDate bis = i + 1 < faelle.size() ? faelle.get(i + 1).ab() : null;
            if (f.ab().isBefore(ende) && (bis == null || bis.isAfter(erster))) {
                out.add(f);
            }
        }
        return out;
    }

    /** Warum der Förderweg die Vorgaben eines Monats nicht trägt; leer = bestimmbar. */
    private static Optional<String> nichtBestimmbar(List<Fallstand> imMonat) {
        for (Fallstand f : imMonat) {
            Vorgaben v = f.vorgaben();
            if (v == null) {
                continue;
            }
            if (MispelAbgrenzungRechenwerk.brauchtStammdaten(v.formelsatz())) {
                return Optional.of("stammdaten_fehlen: " + v.formelsatz() + " braucht Painst/Pbinst und die AW-Regel "
                        + "der Anlage b (Anlage 1 S. 46)");
            }
            if (v.awRegel() == null && !MispelAbgrenzungRechenwerk.awEingaenge(v.formelsatz()).isEmpty()) {
                return Optional.of("aw_regel_fehlt: ohne AW-Regel keine Liste der ÜNB (Anlage 1 S. 17 Fn. 8)");
            }
        }
        return Optional.empty();
    }

    private static Ergebnis ergebnis(int[] n) {
        return new Ergebnis(n[0], n[1], n[2], n[3], n[4], n[5], n[6]);
    }
}
