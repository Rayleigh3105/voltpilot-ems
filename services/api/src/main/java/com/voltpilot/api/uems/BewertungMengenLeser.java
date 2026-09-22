package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BewertungRanglisteDto.*;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** N1/N2/B3: reine Rechnung über gelesene Monatswerte und Bilanzen. Keine Uhr, DB oder Einstufung. */
public final class BewertungMengenLeser {
    private BewertungMengenLeser() {}
    public record AnlagenEingang(UUID id, String name, List<BilanzDto.Bilanz> monate) {}
    public record MessstellenEingang(UUID id, String kennzeichen, UUID anlageId, String traeger,
            String art, boolean direkt, boolean archiviert, MessstelleWerteDto.Werte werte,
            List<BigDecimal> ersatzJeMonat) {}
    public record EinsatzEingang(UUID id, String kennzeichen, String name, UUID prozessId,
            String traeger, List<MessstellenEingang> messstellen) {}

    /** Dieselben NW-1-Eingänge wie Python/TS; auch der Produktivleser benutzt diese Regeln. */
    public static Map<String,Object> nenner(List<BewertungRegeln.Anlage> anlagen) {
        return BewertungRegeln.nenner(anlagen);
    }
    public static Map<String,Object> menge(List<BewertungRegeln.Messstelle> messstellen, String traeger) {
        return BewertungRegeln.menge(messstellen, traeger);
    }

    public static Rangliste lesen(LocalDate von, LocalDate bis, UUID umfangId, Integer fassung,
            boolean teilansicht, boolean strom, List<AnlagenEingang> anlagen, List<EinsatzEingang> einsaetze) {
        var bilanzen = anlagen.stream().map(BewertungMengenLeser::bilanz).toList();
        var n = nenner(bilanzen.stream().map(b -> new BewertungRegeln.Anlage(b.id().toString(),
                b.nenner() != null, b.nenner(), "0", "0")).toList());
        BigDecimal nenner = strom ? zahl((String)n.get("wert")) : null;
        String nennerZustand = strom ? (String)n.get("zustand") : "ohne Anteil";
        List<Einsatz> stromZeilen = new ArrayList<>(), weitere = new ArrayList<>();
        var vergeben = new HashSet<UUID>();
        for (var e : einsaetze) {
            List<Messstelle> ms = e.messstellen().stream()
                    .filter(m -> m.direkt() && !m.archiviert() && m.art().equals("gemessen") && m.traeger().equals(e.traeger()))
                    .map(BewertungMengenLeser::messstelle).toList();
            for (var m : ms) if (!vergeben.add(m.id())) throw new IllegalArgumentException("messstelle_doppelt");
            // Die ausgewählten Messstellen werden genau einmal durch die B3-Regel summiert.
            var m = menge(ms.stream().map(x -> new BewertungRegeln.Messstelle(x.kennzeichen(), e.traeger(),
                    "gemessen", true, false, x.menge(), x.ersatz() == null ? "0" : x.ersatz())).toList(), e.traeger());
            String menge = (String)m.get("menge");
            String zustand = zustand(menge, ms.stream().map(Messstelle::zustand).toList());
            String ersatz = ms.stream().anyMatch(x -> x.menge() != null && x.ersatz() == null) ? null : (String)m.get("ersatz");
            boolean mitAnteil = e.traeger().equals("Strom") && strom;
            String einheit = ms.stream().map(Messstelle::einheit).distinct().reduce((a,b) -> {
                if (!a.equals(b)) throw new IllegalArgumentException("einheiten_verschieden");
                return a;
            }).orElse(e.traeger().equals("Strom") ? "kWh" : null);
            var zeile = new Einsatz(e.id(), e.kennzeichen(), e.name(), e.prozessId(), e.traeger(), einheit,
                    menge, zustand, ersatz, prozent(ersatz, menge), mitAnteil ? prozent(menge, text(nenner)) : null,
                    !mitAnteil ? "ohne Anteil" : !nennerZustand.equals("vollständig") ? "unvollständig"
                            : menge == null ? "keine Werte" : nenner == null || nenner.signum() <= 0 ? "ohne Anteil" : zustand,
                    null, ms);
            (mitAnteil ? stromZeilen : weitere).add(zeile);
        }
        stromZeilen.sort(Comparator.comparing((Einsatz e) -> zahl(e.menge()),
                Comparator.nullsLast(Comparator.reverseOrder())).thenComparing(Einsatz::kennzeichen));
        for (int i=0; i<stromZeilen.size(); i++) {
            var e = stromZeilen.get(i);
            stromZeilen.set(i,new Einsatz(e.id(),e.kennzeichen(),e.name(),e.prozessId(),e.traeger(),e.einheit(),
                    e.menge(),e.zustand(),e.ersatz(),e.ersatzProzent(),e.anteilProzent(),e.anteilZustand(),
                    e.menge() == null ? null : i+1,e.messstellen()));
        }
        weitere.sort(Comparator.comparing(Einsatz::traeger).thenComparing(Einsatz::kennzeichen));
        BigDecimal zugeordnet = stromZeilen.stream().filter(e -> e.menge()!=null).map(e -> zahl(e.menge()))
                .reduce(BigDecimal.ZERO,BigDecimal::add);
        boolean ohneAnlage = stromZeilen.stream().flatMap(e -> e.messstellen().stream())
                .anyMatch(m -> m.menge()!=null && m.anlageId()==null);
        List<Anlage> aus = new ArrayList<>();
        for (var a : bilanzen) {
            var ms = stromZeilen.stream().flatMap(e -> e.messstellen().stream()).filter(m -> a.id().equals(m.anlageId())).toList();
            BigDecimal summe = ms.stream().filter(m -> m.menge()!=null).map(m -> zahl(m.menge())).reduce(BigDecimal.ZERO,BigDecimal::add);
            BigDecimal rest = a.nenner()==null || ohneAnlage ? null : zahl(a.nenner()).subtract(summe);
            aus.add(new Anlage(a.id(),a.name(),a.ab(),a.nenner(),text(summe),text(rest),prozent(text(rest),a.nenner()),
                    a.nenner()==null ? a.zustand() : ohneAnlage || ms.stream().anyMatch(m -> m.zustand().equals("unvollständig"))
                            ? "unvollständig" : a.zustand()));
        }
        String rest = nenner == null ? null : text(nenner.subtract(zugeordnet));
        return new Rangliste(von,bis,umfangId,fassung,teilansicht,
                new Nenner(text(nenner),strom ? "kWh" : null,(int)n.get("vorhanden"),(int)n.get("gesamt"),
                        n.get("vorhanden")+" von "+n.get("gesamt"),nennerZustand),
                strom ? text(zugeordnet) : null,strom ? rest : null,strom ? prozent(text(zugeordnet),text(nenner)) : null,
                !nennerZustand.equals("vollständig") ? nennerZustand : ohneAnlage || stromZeilen.stream().anyMatch(e -> e.zustand().equals("unvollständig"))
                        ? "unvollständig" : "vollständig",List.copyOf(aus),List.copyOf(stromZeilen),List.copyOf(weitere));
    }

    private static Messstelle messstelle(MessstellenEingang m) {
        var werte = m.werte().werte();
        if (werte.size()!=m.ersatzJeMonat().size()) throw new IllegalArgumentException("ersatz_monate_passen_nicht");
        var eingang = new ArrayList<BewertungRegeln.Messstelle>();
        for (int i=0;i<werte.size();i++) eingang.add(new BewertungRegeln.Messstelle(m.kennzeichen()+":"+i,m.traeger(),
                "gemessen",true,false,text(werte.get(i).menge()),text(m.ersatzJeMonat().get(i)) == null ? "0" : text(m.ersatzJeMonat().get(i))));
        var summe = menge(eingang,m.traeger());
        String menge = (String)summe.get("menge");
        String ersatz = m.ersatzJeMonat().stream().anyMatch(x -> x==null) ? null : (String)summe.get("ersatz");
        return new Messstelle(m.id(),m.kennzeichen(),m.anlageId(),m.werte().messstelle().einheit(),menge,
                zustand(menge,werte.stream().map(w -> w.menge()==null ? "keine Werte" : w.zustand()).toList()),
                ersatz,prozent(ersatz,menge),m.werte());
    }
    private static Anlage bilanz(AnlagenEingang a) {
        BigDecimal menge = BigDecimal.ZERO;
        LocalDate ab = null;
        boolean fehlt = a.monate().isEmpty(), hauptzaehler = false;
        var zustaende = new ArrayList<String>();
        for (var b : a.monate()) {
            if (b.hauptzaehler().isEmpty() || b.ausserhalbZugriff()!=null) fehlt=true;
            for (var h : b.hauptzaehler()) {
                hauptzaehler=true;
                if (h.abschnitte().isEmpty()) fehlt=true;
                for (var s : h.abschnitte()) {
                    if (s.werte().isEmpty()) fehlt=true;
                    if (ab==null || s.von().isBefore(ab)) ab=s.von();
                    for (var w : s.werte()) {
                        BigDecimal zufluss = fluss(w.zufluss()), abfluss = fluss(w.abfluss());
                        if (zufluss==null || abfluss==null) fehlt=true;
                        else menge=menge.add(zufluss).subtract(abfluss);
                        if (w.zufluss().gesamt()>0) zustaende.add(w.zufluss().zustand());
                        if (w.abfluss().gesamt()>0) zustaende.add(w.abfluss().zustand());
                    }
                }
            }
        }
        String wert = fehlt ? null : text(menge);
        return new Anlage(a.id(),a.name(),ab,wert,null,null,null,
                !hauptzaehler ? "ohne Bilanz" : fehlt ? "unvollständig" : zustand(wert,zustaende));
    }
    private static BigDecimal fluss(BilanzDto.Summe s) {
        if (s.gesamt()==0) return BigDecimal.ZERO;
        return s.mitWerten()!=s.gesamt() || "unvollständig".equals(s.zustand()) ? null : s.menge();
    }
    private static String zustand(String menge,List<String> zustaende) {
        if (menge==null) return "keine Werte";
        if (zustaende.stream().anyMatch(z -> z==null || z.equals("unvollständig") || z.equals("keine Werte"))) return "unvollständig";
        return zustaende.contains("mit Ersatzwert") ? "mit Ersatzwert" : "vollständig";
    }
    private static BigDecimal zahl(String s) { return s==null ? null : new BigDecimal(s); }
    private static String text(BigDecimal n) { return n==null ? null : n.stripTrailingZeros().toPlainString(); }
    private static String prozent(String n,String d) { return BewertungRegeln.prozent(zahl(n),zahl(d)); }
}
