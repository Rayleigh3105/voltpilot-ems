package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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
 * <p><b>Die Werte der Eingänge</b> liest {@link KennzahlEingangLeser} — dieselben Wege wie der Rechenlauf
 * ({@link KennzahlLauf}), nie nachgerechnet: eine Messstelle über ihr Lesemodell im Raster der Periode, eine Bezugsgröße
 * über ihre wirksame Fassung, ein Stammdatum am Stichtag, eine Kennzahl ihr gespeicherter Wert derselben Periode.
 * Feinere Bezugsgrößen-Perioden zählen nur, wenn JEDE einen wirksamen Wert hat; sonst fehlt der Nenner — nie verteilt,
 * nie geschätzt. Eine Woche liest die Messstelle als freien Zeitraum der Regel, Montag bis Sonntag in der Zone ihres
 * Standorts (IP-12).
 */
@Service
public class KennzahlVorschauService {

    static final int PERIODEN = 3;

    private final KennzahlService kennzahlen;
    private final KennzahlRepository repo;
    private final KennzahlEingangLeser leser;
    private final TransactionTemplate lesen;

    public KennzahlVorschauService(KennzahlService kennzahlen, KennzahlRepository repo, KennzahlEingangLeser leser,
            PlatformTransactionManager transactionManager) {
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.leser = leser;
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
            List<KennzahlRegeln.Teil> teile = u.eingaenge().stream().map(x -> leser.teil(x, art, spanne)).toList();
            String formDerPaare = u.eingaenge().get(0).rechenform();
            antrag = new KennzahlRegeln.Antrag(u.rechenform(), p, u.einheit(), null, null, false, false, teile, "ebene",
                    KennzahlEingangLeser.wortEbene(u.eingaenge()), null, formDerPaare, null, List.of(), null, null);
        } else {
            antrag = new KennzahlRegeln.Antrag(u.rechenform(), p, u.einheit(),
                    leser.eingang(rolle(u, "zaehler"), art, spanne), leser.eingang(rolle(u, "nenner"), art, spanne),
                    u.komplement(), false, null, null, null, null, null, null, List.of(), null, null);
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
}
