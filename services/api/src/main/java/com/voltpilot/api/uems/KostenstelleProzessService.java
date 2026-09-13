package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KostenstelleProzessAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Art;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Ausserhalb;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Objekt;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Zuordnung;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.UnternehmenRepository.Unternehmen;
import com.voltpilot.api.web.dto.KostenstelleProzessDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Kostenstelle, Prozess und die Zuordnung einer Messstelle zu Prozessen (UEMS AP-10 IP-7, Konzept
 * §4.2, §5.7). Die Datenbank ({@code V20260913160000}) hält die Grenzen — eine Ebene, beenden statt
 * löschen, eine Zuordnung nie länger als ihr Ziel; hier werden sie VOR dem Schreiben mit Grund und
 * Fakten beantwortet, damit keine Ablehnung als 500 ankommt. Jeder Schreibvorgang läuft unter der
 * Sperre des Unternehmens (wie die Ortsstruktur): die Schreibvorgänge eines Kundenbereichs nacheinander.
 *
 * <p>Beenden statt löschen: es gibt keinen Löschweg. Ein Ende, das eine Zuordnung abschneiden würde,
 * ist 409 {@code zuordnung_besteht} mit der Liste — nie still gekürzt.
 */
@Service
public class KostenstelleProzessService {

    static final String PROTOKOLL_ART = "prozesse_zugeordnet";
    private static final Pattern KENNZEICHEN = Pattern.compile("^[A-Z0-9./-]{2,16}$");

    private final KostenstelleProzessRepository repo;
    private final MessstelleRepository messstellen;
    private final MessstelleAenderungRepository aenderungen;
    private final UnternehmenRepository unternehmen;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public KostenstelleProzessService(KostenstelleProzessRepository repo, MessstelleRepository messstellen,
            MessstelleAenderungRepository aenderungen, UnternehmenRepository unternehmen, ObjectMapper json,
            PlatformTransactionManager transactionManager) {
        this.repo = repo;
        this.messstellen = messstellen;
        this.aenderungen = aenderungen;
        this.unternehmen = unternehmen;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „rückwirkend“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------------ lesen

    public KostenstelleProzessDto.Kostenstellen kostenstellen(LocalDate stichtag) {
        ZoneId zone = zone();
        return new KostenstelleProzessDto.Kostenstellen(stichtag, repo.alle(Art.KOSTENSTELLE).stream()
                .filter(o -> stichtag == null || o.deckt(stichtag, stichtag))
                .map(o -> kostenstelle(o, zone)).toList());
    }

    public KostenstelleProzessDto.Kostenstelle kostenstelle(UUID id) {
        return kostenstelle(finde(Art.KOSTENSTELLE, id), zone());
    }

    public KostenstelleProzessDto.Prozesse prozesse(LocalDate stichtag) {
        ZoneId zone = zone();
        return new KostenstelleProzessDto.Prozesse(stichtag, repo.alle(Art.PROZESS).stream()
                .filter(o -> stichtag == null || o.deckt(stichtag, stichtag))
                .map(o -> prozess(o, zone)).toList());
    }

    public KostenstelleProzessDto.Prozess prozess(UUID id) {
        return prozess(finde(Art.PROZESS, id), zone());
    }

    /** Die Prozesse einer Messstelle: alle wirksamen Intervalle — oder mit {@code am} die an dem Tag. */
    public KostenstelleProzessDto.MessstelleProzesse prozesseDerMessstelle(UUID messstelle, LocalDate am) {
        Messstelle m = messstelle(messstelle);
        List<KostenstelleProzessDto.Zuordnung> zeilen = new ArrayList<>();
        for (Zuordnung z : repo.zuordnungen(messstelle)) {
            boolean amTag = am == null || (!am.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !am.isAfter(z.gueltigBis())));
            if (amTag) {
                zeilen.add(new KostenstelleProzessDto.Zuordnung(z.id(),
                        new KostenstelleProzessDto.Verweis(z.prozessId(), z.prozessKennzeichen()), z.prozessName(),
                        z.gueltigAb(), z.gueltigBis(), z.gueltigBis() != null && z.gueltigBis().equals(z.prozessBis())));
            }
        }
        return new KostenstelleProzessDto.MessstelleProzesse(m.id(), m.kennzeichen(), am, zeilen);
    }

    // --------------------------------------------------------------------- schreiben

    /**
     * Legt eine Kostenstelle oder einen Prozess an. Reihenfolge: Form (400) → Kennzeichen-Form (422)
     * → Zeitraum (422) → Unternehmen da (409) → Kennzeichen frei (409) → beim Prozess: Elternteil da
     * (422 {@code eltern_unbekannt}), selbst ohne Elternteil (422 {@code eine_ebene}), besteht an jedem
     * Tag des neuen (422 {@code ziel_besteht_nicht}).
     */
    public UUID anlegen(Art art, KostenstelleProzessDto.Anlegen a, ProtokollAkteur wer) {
        if (a == null) {
            throw KostenstelleProzessAbgelehnt.anfrage("");
        }
        String kennzeichen = pflicht("kennzeichen", a.kennzeichen());
        String name = pflicht("name", a.name()).strip();
        LocalDate ab = tag("gueltig_ab", pflicht("gueltig_ab", a.gueltigAb()));
        LocalDate bis = a.gueltigBis() == null || a.gueltigBis().isBlank() ? null : tag("gueltig_bis", a.gueltigBis());
        UUID elternId = null;
        if (art == Art.PROZESS && a.elternId() != null && !a.elternId().isBlank()) {
            elternId = uuid("eltern_id", a.elternId());
        } else if (art == Art.KOSTENSTELLE && a.elternId() != null) {
            // Die Kostenstelle ist flach: das Feld gibt es an ihr nicht.
            throw KostenstelleProzessAbgelehnt.anfrage("eltern_id");
        }
        if (!KENNZEICHEN.matcher(kennzeichen).matches()) {
            throw new KostenstelleProzessAbgelehnt(Ablehnung.KENNZEICHEN_FORMAT, Map.of("feld", "kennzeichen"));
        }
        if (bis != null && bis.isBefore(ab)) {
            throw zeitraum(ab, bis);
        }
        UUID tenant = TenantContext.get();
        UUID eltern = elternId;
        return schreibe(() -> transaktion.execute(tx -> {
            Unternehmen u = sperre();
            if (repo.kennzeichenBelegt(art, kennzeichen)) {
                throw new KostenstelleProzessAbgelehnt(Ablehnung.KENNZEICHEN_BELEGT, Map.of("kennzeichen", kennzeichen));
            }
            if (eltern != null) {
                Objekt e = repo.finde(Art.PROZESS, eltern).orElseThrow(() ->
                        new KostenstelleProzessAbgelehnt(Ablehnung.ELTERN_UNBEKANNT, Map.of("feld", "eltern_id")));
                if (e.elternId() != null) {
                    Map<String, Object> f = new LinkedHashMap<>();
                    f.put("eltern", e.kennzeichen());
                    f.put("eltern_von", e.elternKennzeichen());
                    throw new KostenstelleProzessAbgelehnt(Ablehnung.EINE_EBENE, f);
                }
                if (!e.deckt(ab, bis)) {
                    throw zielBestehtNicht(e, ab, bis);
                }
            }
            return repo.anlegen(art, tenant, u.id(), kennzeichen, name, eltern, ab, bis, wer.sub());
        }));
    }

    /** Nur der Name: Kennzeichen, Beginn und Elternteil bleiben, wie sie angelegt wurden. */
    public void umbenennen(Art art, UUID id, KostenstelleProzessDto.Umbenennen a) {
        String name = pflicht("name", a == null ? null : a.name()).strip();
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            finde(art, id);
            repo.umbenennen(art, id, name);
            return id;
        }));
    }

    /**
     * Beendet: der letzte Tag. Ein Ende wird nur vorgezogen, nie hinausgeschoben oder aufgehoben (409
     * {@code bereits_beendet}, Muster „nur verkürzt“); gelten
     * Zuordnungen länger, antwortet 409 {@code zuordnung_besteht} mit JEDER davon — gekürzt wird nichts.
     */
    public void beenden(Art art, UUID id, KostenstelleProzessDto.Beenden a) {
        LocalDate bis = tag("gueltig_bis", pflicht("gueltig_bis", a == null ? null : a.gueltigBis()));
        UUID tenant = TenantContext.get();
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            Objekt o = finde(art, id);
            if (o.gueltigBis() != null && !bis.isBefore(o.gueltigBis())) {
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("kennzeichen", o.kennzeichen());
                f.put("gueltig_bis", o.gueltigBis().toString());
                throw new KostenstelleProzessAbgelehnt(Ablehnung.BEREITS_BEENDET, f);
            }
            if (bis.isBefore(o.gueltigAb())) {
                throw zeitraum(o.gueltigAb(), bis);
            }
            List<Ausserhalb> imWeg = repo.ausserhalb(art, tenant, id, o.gueltigAb(), bis);
            if (!imWeg.isEmpty()) {
                throw zuordnungBesteht(o, bis, imWeg);
            }
            repo.beenden(art, id, bis);
            return id;
        }));
    }

    /**
     * Ab {@code gueltig_ab} gehört die Messstelle zu GENAU diesen Prozessen (leer = zu keinem). Was an
     * dem Tag läuft und bleibt, läuft weiter; was an dem Tag läuft und nicht mehr gilt, endet am VORTAG;
     * was an oder nach dem Tag beginnt und nicht passt, wird aufgehoben (lesbar). Ein neues Intervall
     * endet mit seinem Prozess ({@code endet_mit_prozess}) — die Datenbank lässt es nie länger gelten.
     * GENAU EIN Protokolleintrag {@code prozesse_zugeordnet}, wenn sich etwas ändert; eine Ablehnung
     * schreibt nichts.
     */
    public KostenstelleProzessDto.MessstelleProzesse prozesseSetzen(UUID messstelle,
            KostenstelleProzessDto.ProzesseSetzen a, ProtokollAkteur wer) {
        Messstelle m = messstelle(messstelle);
        if (a == null) {
            throw KostenstelleProzessAbgelehnt.anfrage("");
        }
        LocalDate ab = tag("gueltig_ab", pflicht("gueltig_ab", a.gueltigAb()));
        if (a.prozesse() == null) {
            throw KostenstelleProzessAbgelehnt.anfrage("prozesse");
        }
        Set<UUID> gewaehlt = new LinkedHashSet<>();
        for (String text : a.prozesse()) {
            if (text == null || !gewaehlt.add(uuid("prozesse", text))) {
                throw KostenstelleProzessAbgelehnt.anfrage("prozesse");
            }
        }
        if (m.archiviertAm() != null) {
            throw new KostenstelleProzessAbgelehnt(Ablehnung.MESSSTELLE_ARCHIVIERT, Map.of("kennzeichen", m.kennzeichen()));
        }
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        schreibe(() -> transaktion.execute(tx -> {
            Unternehmen u = sperre();
            Map<UUID, Objekt> prozesse = new LinkedHashMap<>();
            for (UUID id : gewaehlt) {
                Objekt p = repo.finde(Art.PROZESS, id).orElseThrow(() ->
                        new KostenstelleProzessAbgelehnt(Ablehnung.PROZESS_UNBEKANNT, Map.of("prozess_id", id.toString())));
                // Der Prozess besteht am ersten Tag; das neue Intervall endet mit ihm.
                if (!p.deckt(ab, ab)) {
                    throw zielBestehtNicht(p, ab, null);
                }
                prozesse.put(id, p);
            }
            List<Zuordnung> vorher = repo.zuordnungen(messstelle);
            Set<UUID> laeuftWeiter = new HashSet<>();
            List<UUID> aufheben = new ArrayList<>();
            List<UUID> beenden = new ArrayList<>();
            for (Zuordnung z : vorher) {
                if (z.gueltigBis() != null && z.gueltigBis().isBefore(ab)) {
                    continue;
                }
                Objekt p = prozesse.get(z.prozessId());
                boolean passt = p != null && Objects.equals(z.gueltigBis(), p.gueltigBis());
                if (!z.gueltigAb().isBefore(ab)) {
                    if (passt && z.gueltigAb().equals(ab)) {
                        laeuftWeiter.add(z.prozessId());
                    } else {
                        aufheben.add(z.id());
                    }
                } else if (passt) {
                    laeuftWeiter.add(z.prozessId());
                } else {
                    beenden.add(z.id());
                }
            }
            List<Objekt> neu = prozesse.values().stream().filter(p -> !laeuftWeiter.contains(p.id())).toList();
            if (aufheben.isEmpty() && beenden.isEmpty() && neu.isEmpty()) {
                return messstelle;
            }
            aufheben.forEach(id -> repo.zuordnungAufheben(id, jetzt));
            beenden.forEach(id -> repo.zuordnungBeenden(id, ab.minusDays(1)));
            neu.forEach(p -> repo.zuordnungEintragen(tenant, messstelle, p.id(), ab, p.gueltigBis(), wer.sub()));
            protokoll(tenant, m, amTag(vorher, ab), new TreeSet<>(prozesse.values().stream().map(Objekt::kennzeichen)
                    .toList()), ab, ZoneId.of(u.zeitzone()), jetzt, a.grund(), wer);
            return messstelle;
        }));
        return prozesseDerMessstelle(messstelle, null);
    }

    // ------------------------------------------------------------------------ Gerüst

    private Objekt finde(Art art, UUID id) {
        return repo.finde(art, id).orElseThrow(() -> KostenstelleProzessAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private Messstelle messstelle(UUID id) {
        return messstellen.finde(id).orElseThrow(() -> KostenstelleProzessAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Die Zeilensperre des Unternehmens — ohne Unternehmen gibt es nichts zu verwalten. */
    private Unternehmen sperre() {
        if (unternehmen.sperren().isEmpty()) {
            throw KostenstelleProzessAbgelehnt.von(Ablehnung.UNTERNEHMEN_NICHT_ANGELEGT);
        }
        return unternehmen.desKundenbereichs().orElseThrow();
    }

    private ZoneId zone() {
        return unternehmen.desKundenbereichs().map(u -> ZoneId.of(u.zeitzone())).orElse(MessstelleService.ZEITZONE);
    }

    private static List<String> amTag(List<Zuordnung> zeilen, LocalDate tag) {
        return new TreeSet<>(zeilen.stream()
                .filter(z -> !tag.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !tag.isAfter(z.gueltigBis())))
                .map(Zuordnung::prozessKennzeichen).toList()).stream().toList();
    }

    /** GENAU EIN Eintrag: {@code gilt_ab} ist Mitternacht des Tages, {@code rueckwirkend} wie bei Ort und Stellung. */
    private void protokoll(UUID tenant, Messstelle m, List<String> alt, Set<String> neu, LocalDate ab, ZoneId zone,
            Instant jetzt, String grund, ProtokollAkteur wer) {
        boolean rueckwirkend = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                OffsetDateTime.ofInstant(jetzt, zone), ab, null, zone, null)).art() == Rueckwirkung.RUECKWIRKEND;
        aenderungen.eintragen(new NeuerEintrag(tenant, m.id(), PROTOKOLL_ART, alsJson(form(ab, alt)),
                alsJson(form(ab, List.copyOf(neu))), ab.atStartOfDay(zone).toInstant(), rueckwirkend,
                grund == null || grund.isBlank() ? null : grund, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private static Map<String, Object> form(LocalDate ab, List<String> prozesse) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("gueltig_ab", ab.toString());
        f.put("prozesse", prozesse);
        return f;
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static KostenstelleProzessDto.Kostenstelle kostenstelle(Objekt o, ZoneId zone) {
        return new KostenstelleProzessDto.Kostenstelle(o.id(), o.kennzeichen(), o.name(), o.gueltigAb(), o.gueltigBis(),
                o.angelegtAm().atZone(zone).toOffsetDateTime());
    }

    private static KostenstelleProzessDto.Prozess prozess(Objekt o, ZoneId zone) {
        return new KostenstelleProzessDto.Prozess(o.id(), o.kennzeichen(), o.name(),
                o.elternId() == null ? null : new KostenstelleProzessDto.Verweis(o.elternId(), o.elternKennzeichen()),
                o.gueltigAb(), o.gueltigBis(), o.angelegtAm().atZone(zone).toOffsetDateTime());
    }

    private static KostenstelleProzessAbgelehnt zeitraum(LocalDate ab, LocalDate bis) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("gueltig_ab", ab.toString());
        f.put("gueltig_bis", bis.toString());
        return new KostenstelleProzessAbgelehnt(Ablehnung.ZEITRAUM_UNGUELTIG, f);
    }

    private static KostenstelleProzessAbgelehnt zielBestehtNicht(Objekt ziel, LocalDate ab, LocalDate bis) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("kennzeichen", ziel.kennzeichen());
        f.put("besteht_ab", ziel.gueltigAb().toString());
        f.put("besteht_bis", ziel.gueltigBis() == null ? null : ziel.gueltigBis().toString());
        f.put("gueltig_ab", ab.toString());
        f.put("gueltig_bis", bis == null ? null : bis.toString());
        return new KostenstelleProzessAbgelehnt(Ablehnung.ZIEL_BESTEHT_NICHT, f);
    }

    private static KostenstelleProzessAbgelehnt zuordnungBesteht(Objekt o, LocalDate bis, List<Ausserhalb> imWeg) {
        List<Map<String, Object>> liste = new ArrayList<>();
        for (Ausserhalb x : imWeg) {
            Map<String, Object> z = new LinkedHashMap<>();
            z.put("art", switch (x.tabelle()) {
                case "messstelle_prozess" -> "messstelle";
                case "prozess" -> "unterprozess";
                default -> x.tabelle();
            });
            z.put("kennzeichen", x.kennzeichen());
            z.put("gueltig_ab", x.gueltigAb().toString());
            z.put("gueltig_bis", x.gueltigBis() == null ? null : x.gueltigBis().toString());
            liste.add(z);
        }
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("kennzeichen", o.kennzeichen());
        f.put("gueltig_bis", bis.toString());
        f.put("zuordnungen", liste);
        return new KostenstelleProzessAbgelehnt(Ablehnung.ZUORDNUNG_BESTEHT, f);
    }

    private static String pflicht(String feld, String text) {
        if (text == null || text.isBlank()) {
            throw KostenstelleProzessAbgelehnt.anfrage(feld);
        }
        return text;
    }

    private static LocalDate tag(String feld, String text) {
        try {
            return LocalDate.parse(text.strip());
        } catch (RuntimeException e) {
            throw KostenstelleProzessAbgelehnt.anfrage(feld);
        }
    }

    private static UUID uuid(String feld, String text) {
        try {
            return UUID.fromString(text.strip());
        } catch (IllegalArgumentException e) {
            throw KostenstelleProzessAbgelehnt.anfrage(feld);
        }
    }

    /**
     * Schreibt und übersetzt das, was die Sperre nicht ausschließt (ein Schreiber ohne sie): die
     * Grenzen der Datenbank kommen als dieselben Ablehnungen an — nie als 500.
     */
    private <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataAccessException e) {
            String constraint = constraint(e);
            if (constraint == null) {
                throw e;
            }
            Ablehnung ablehnung = switch (constraint) {
                case "kostenstelle_kennzeichen_eindeutig", "prozess_kennzeichen_eindeutig" -> Ablehnung.KENNZEICHEN_BELEGT;
                case "prozess_eine_ebene" -> Ablehnung.EINE_EBENE;
                case "kostenstelle_zuordnung_besteht", "prozess_zuordnung_besteht" -> Ablehnung.ZUORDNUNG_BESTEHT;
                case "messstelle_prozess_prozess_besteht", "prozess_eltern_besteht" -> Ablehnung.ZIEL_BESTEHT_NICHT;
                case "messstelle_prozess_keine_ueberlappung" -> Ablehnung.ZUORDNUNG_UEBERLAPPT;
                default -> null;
            };
            if (ablehnung == null) {
                throw e;
            }
            throw KostenstelleProzessAbgelehnt.von(ablehnung);
        }
    }

    /**
     * Der Constraint-Name der Postgres-Ablehnung. Der Treiber liegt nur zur Laufzeit auf dem Klassenpfad —
     * darum über {@code getServerErrorMessage().getConstraint()} per Reflexion, ohne Kompilier-Abhängigkeit.
     */
    private static String constraint(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            try {
                Object meldung = t.getClass().getMethod("getServerErrorMessage").invoke(t);
                if (meldung != null) {
                    return (String) meldung.getClass().getMethod("getConstraint").invoke(meldung);
                }
            } catch (ReflectiveOperationException keinPostgresFehler) {
                // weiter mit der Ursache
            }
        }
        return null;
    }
}
