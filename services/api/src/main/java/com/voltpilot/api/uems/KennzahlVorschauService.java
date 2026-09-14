package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die VORSCHAU einer Kennzahl (UEMS AP-11 IP-5, §5.1 Schritt 5, K20): dieselben Prüfungen wie das Anlegen — und
 * ohne Befund die letzten drei abgeschlossenen Perioden, gerechnet mit der Regel {@link KennzahlRegeln#wert}.
 *
 * <p><b>Sie schreibt nichts</b> (Muster Import-Vorschau): alles läuft in EINER Nur-Lese-Transaktion
 * ({@code BEGIN READ ONLY}), die Datenbank selbst lehnt einen Schreibversuch ab. Kein Kennzeichen wird belegt, keine
 * Fassung, kein Protokoll.
 *
 * <p><b>Befund oder Fehler:</b> eine fachliche Ablehnung (409, 422 — und eine Regel, die die Eingänge als
 * unvollständig nennt) ist ein Befund der Antwort; die Form der Anfrage (400) und das Recht (403/404) antworten wie
 * beim Anlegen — die Vorschau zeigt Werte und verlangt das Recht zum Definieren.
 *
 * <p><b>Die Werte der Eingänge</b> werden gelesen, nie nachgerechnet: eine Messstelle über ihr Lesemodell
 * ({@link MessstelleWerteService#werte}) im Raster der Periode, eine Bezugsgröße über ihres
 * ({@link BezugsgroesseService#werte} Lesart {@code wirksam}, ein Stammdatum am Stichtag), eine Kennzahl ihr jüngster
 * gespeicherter Wert (vor IP-6 gibt es keinen — „keine Werte“). Feinere Bezugsgrößen-Perioden zählen nur, wenn JEDE
 * einen wirksamen Wert hat; sonst fehlt der Nenner — nie verteilt, nie geschätzt. Eine Kennzahl je Woche hat noch
 * keine Vorschau-Perioden: das Messstellen-Lesemodell kennt kein Wochen-Raster (Wochen-Perioden sind IP-12).
 */
@Service
public class KennzahlVorschauService {

    static final int PERIODEN = 3;

    private final KennzahlService kennzahlen;
    private final KennzahlRepository repo;
    private final MessstelleWerteService messwerte;
    private final BezugsgroesseService bezugswerte;
    private final TransactionTemplate lesen;

    public KennzahlVorschauService(KennzahlService kennzahlen, KennzahlRepository repo, MessstelleWerteService messwerte,
            BezugsgroesseService bezugswerte, PlatformTransactionManager transactionManager) {
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.messwerte = messwerte;
        this.bezugswerte = bezugswerte;
        this.lesen = new TransactionTemplate(transactionManager);
        this.lesen.setReadOnly(true);
    }

    public KennzahlDto.Vorschau vorschau(KennzahlDto.Anfrage a, ProtokollAkteur wer) {
        KennzahlService.Entwurf e = kennzahlen.entwurf(a, false, wer);
        Instant jetzt = kennzahlen.jetzt();
        return lesen.execute(s -> {
            List<KennzahlDto.Befund> befunde = new ArrayList<>();
            KennzahlService.Geltung g = null;
            KennzahlService.Urteil u = null;
            try {
                g = kennzahlen.geltung(a.geltungArt(), a.geltungId(), jetzt);
            } catch (KennzahlAbgelehnt x) {
                befund(x, befunde);
            }
            if (g != null) {
                kennzahlen.darf(wer, g, jetzt);
                try {
                    String kennzeichen = KennzahlService.kennzeichenFuerNeue(e.kennzeichen(), repo.jeBelegt());
                    u = kennzahlen.berechnung(a.rechenform(), g, a.eingaenge(), a.komplement(), a.periodeArt(),
                            kennzeichen, null, LocalDate.ofInstant(jetzt, g.zone()), kennzahlen.katalog());
                } catch (KennzahlAbgelehnt x) {
                    befund(x, befunde);
                }
            }
            String art = u == null ? null : a.periodeArt() != null ? a.periodeArt() : u.grundperiode();
            List<KennzahlDto.VorschauPeriode> perioden = u == null ? List.of() : letzte(u, g, art, jetzt);
            return new KennzahlDto.Vorschau(List.copyOf(befunde), g == null ? null : g.rechteGeltung(),
                    g == null ? null : g.standort(), g == null ? null : g.kennung(), u == null ? null : u.einheit(),
                    u == null ? null : u.einheitAnzeige(), u == null ? null : u.grundperiode(),
                    u == null ? List.of() : u.perioden(), art, perioden);
        });
    }

    /** 403/404 fliegen weiter; jede andere Ablehnung der Prüfung ist ein Befund. */
    private static void befund(KennzahlAbgelehnt x, List<KennzahlDto.Befund> befunde) {
        if (x.status() == 403 || x.status() == 404) {
            throw x;
        }
        befunde.add(new KennzahlDto.Befund(x.code(), x.getMessage(), x.fakten()));
    }

    /** Die letzten {@link #PERIODEN} abgeschlossenen Perioden vor heute, die jüngste zuerst. */
    private List<KennzahlDto.VorschauPeriode> letzte(KennzahlService.Urteil u, KennzahlService.Geltung g, String art,
            Instant jetzt) {
        if (art == null || "woche".equals(art)) {
            return List.of();
        }
        LocalDate[] spanne = BezugsPeriode.spanneUm(LocalDate.ofInstant(jetzt, g.zone()), art);
        List<KennzahlDto.VorschauPeriode> aus = new ArrayList<>();
        for (int i = 0; i < PERIODEN; i++) {
            spanne = BezugsPeriode.spanneUm(spanne[0].minusDays(1), art);
            aus.add(periode(u, art, spanne));
        }
        return List.copyOf(aus);
    }

    private KennzahlDto.VorschauPeriode periode(KennzahlService.Urteil u, String art, LocalDate[] spanne) {
        String schluessel = BezugsPeriode.schluesselVon(spanne[0], art);
        KennzahlRegeln.Periode p = new KennzahlRegeln.Periode(art, schluessel);
        KennzahlRegeln.Antrag antrag;
        if (KennzahlRegeln.ZUSAMMENFASSUNG.equals(u.rechenform())) {
            List<KennzahlRegeln.Teil> teile = u.eingaenge().stream().map(x -> teil(x, art, spanne)).toList();
            String formDerPaare = u.eingaenge().get(0).rechenform();
            antrag = new KennzahlRegeln.Antrag(u.rechenform(), p, u.einheit(), null, null, false, false, teile, "ebene",
                    "Kennzahlen", null, formDerPaare, null, List.of(), null, null);
        } else {
            antrag = new KennzahlRegeln.Antrag(u.rechenform(), p, u.einheit(), eingang(rolle(u, "zaehler"), art, spanne),
                    eingang(rolle(u, "nenner"), art, spanne), u.komplement(), false, null, null, null, null, null, null,
                    List.of(), null, null);
        }
        KennzahlRegeln.Ergebnis r = KennzahlRegeln.wert(antrag);
        return new KennzahlDto.VorschauPeriode(art, schluessel, KennzahlRegeln.periodeText(art, schluessel), spanne[0],
                spanne[1], KennzahlRegeln.text(r.wert()), KennzahlRegeln.text(r.zaehler()), KennzahlRegeln.text(r.nenner()),
                r.zustand(), r.richtung(), r.grund(), KennzahlRegeln.text(r.abdeckungProzent()), r.fassung(),
                r.kennzeichen(), r.anzeige(), r.kundensatz());
    }

    private static Aufgeloest rolle(KennzahlService.Urteil u, String rolle) {
        return u.eingaenge().stream().filter(x -> rolle.equals(x.rolle())).findFirst().orElseThrow();
    }

    private KennzahlRegeln.Eingang eingang(Aufgeloest x, String art, LocalDate[] spanne) {
        return switch (x.art()) {
            case KennzahlRegeln.MESSSTELLE -> messstelle(x, art, spanne);
            case KennzahlRegeln.BEZUGSGROESSE -> KennzahlRegeln.STAMMDATUM.equals(x.wertart())
                    ? stammdatum(x, art, spanne) : periodenwert(x, spanne);
            default -> repo.juengsterWert(x.id(), art, spanne[0])
                    .map(w -> new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, null, null, w.wert(),
                            x.einheit(), w.wert() == null ? ErgebnisZustand.KEINE_WERTE : w.mengeZustand(),
                            w.abdeckungProzent(), "endgueltig".equals(w.zustand()), null, List.of()))
                    .orElseGet(() -> keineWerte(x));
        };
    }

    private KennzahlRegeln.Eingang messstelle(Aufgeloest x, String art, LocalDate[] spanne) {
        MessstelleWerteDto.Werte w;
        try {
            w = messwerte.werte(x.kennzeichen(), art, spanne[0].toString(), spanne[1].toString(), null);
        } catch (ResponseStatusException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return keineWerte(x);
            }
            throw ex;
        }
        if (w.werte().isEmpty() || w.werte().get(0).menge() == null) {
            return keineWerte(x);
        }
        MessstelleWerteDto.Wert v = w.werte().get(0);
        return new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, null, null, v.menge(),
                w.messstelle().einheit(), v.zustand(),
                v.abdeckungProzent() == null ? null : BigDecimal.valueOf(v.abdeckungProzent()),
                ViertelstundeRegeln.ENDGUELTIG.equals(v.fassung()), null, v.kennzeichen() == null ? List.of() : v.kennzeichen());
    }

    private KennzahlRegeln.Eingang stammdatum(Aufgeloest x, String art, LocalDate[] spanne) {
        BezugsgroesseDto.Stammdatum sd = bezugswerte.stammdatum(x.id(), art, spanne[0], spanne[1]);
        String betrag = sd.perioden() == null ? null : sd.perioden().stream().filter(p -> spanne[0].equals(p.von()))
                .map(BezugsgroesseDto.Stichtagwert::betrag).findFirst().orElse(null);
        return new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, KennzahlRegeln.STAMMDATUM, null,
                betrag == null ? null : new BigDecimal(betrag), x.einheit(), null, null, true, null, List.of());
    }

    /**
     * Ein Periodenwert: in der eigenen Periode der wirksame Betrag; aus feineren Perioden die Summe, wenn JEDE einen
     * wirksamen Betrag hat — sonst kein Wert (der Nenner fehlt). Ein zurückgenommener Wert heißt so.
     */
    private KennzahlRegeln.Eingang periodenwert(Aufgeloest x, LocalDate[] spanne) {
        String eigene = x.periodeArt();
        List<BezugsgroesseDto.Wert> werte = bezugswerte.werte(x.id(), spanne[0], spanne[1],
                BezugsgroesseRegeln.LESARTEN.get(0)).werte();
        Set<String> erwartet = new LinkedHashSet<>();
        for (LocalDate t = spanne[0]; !t.isAfter(spanne[1]); t = t.plusDays(1)) {
            erwartet.add(BezugsPeriode.schluesselVon(t, eigene));
        }
        Map<String, BezugsgroesseDto.Wert> jeSchluessel = new LinkedHashMap<>();
        for (BezugsgroesseDto.Wert w : werte) {
            if (w.periodeVon() != null && !w.periodeVon().isBefore(spanne[0])
                    && (w.periodeBis() == null || !w.periodeBis().isAfter(spanne[1]))) {
                jeSchluessel.put(BezugsPeriode.schluesselVon(w.periodeVon(), eigene), w);
            }
        }
        BigDecimal summe = BigDecimal.ZERO;
        boolean endgueltig = true;
        String status = KennzahlRegeln.WIRKSAM;
        for (String k : erwartet) {
            BezugsgroesseDto.Wert w = jeSchluessel.get(k);
            if (w == null || w.wirksamerBetrag() == null) {
                boolean zurueck = w != null && w.fassungen() != null && w.fassungen().stream()
                        .anyMatch(f -> KennzahlRegeln.ZURUECKGENOMMEN.equals(f.status()));
                return new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, KennzahlRegeln.PERIODENWERT,
                        zurueck && erwartet.size() == 1 ? KennzahlRegeln.ZURUECKGENOMMEN : null, null, x.einheit(), null,
                        null, false, null, List.of());
            }
            summe = summe.add(new BigDecimal(w.wirksamerBetrag()));
            endgueltig &= !w.standOffen();
        }
        return new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, KennzahlRegeln.PERIODENWERT, status,
                summe, x.einheit(), null, null, endgueltig, null, List.of());
    }

    private KennzahlRegeln.Teil teil(Aufgeloest x, String art, LocalDate[] spanne) {
        String geltung = x.kennzahl() == null ? null
                : repo.geltungName(x.kennzahl().geltungArt(), x.kennzahl().geltungId()).orElse(null);
        return repo.juengsterWert(x.id(), art, spanne[0])
                .map(w -> new KennzahlRegeln.Teil(x.kennzeichen(), geltung, w.zaehler(), w.nenner(), w.mengeZustand(),
                        w.richtung(), w.abdeckungProzent(), "endgueltig".equals(w.zustand()), List.of()))
                .orElseGet(() -> new KennzahlRegeln.Teil(x.kennzeichen(), geltung, null, null, ErgebnisZustand.KEINE_WERTE,
                        null, null, false, List.of()));
    }

    private static KennzahlRegeln.Eingang keineWerte(Aufgeloest x) {
        return new KennzahlRegeln.Eingang(x.art(), x.kennzeichen(), x.name(), null, x.wertart(), null, null,
                x.einheit() == null ? "" : x.einheit(), ErgebnisZustand.KEINE_WERTE, null, false, null, List.of());
    }
}
