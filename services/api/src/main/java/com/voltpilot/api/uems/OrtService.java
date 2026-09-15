package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ArchivErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Archiviert;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaecheAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaecheErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenIntervallMitZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Vorgang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.WiederherstellErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.WiederherstellGrund;
import com.voltpilot.api.uems.OrtsbaumLesemodell.OrtsbaumAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import com.voltpilot.api.web.dto.OrtDto;
import com.voltpilot.api.web.dto.StandortDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Gebäude und Bereiche anlegen, bearbeiten, ihre Fläche ab einem Tag setzen — und der
 * Ortsbaum eines Standorts zum Stichtag (UEMS AP-02 IP-5). Je Schreibvorgang EINE
 * Transaktion und GENAU EIN Eintrag im Änderungsprotokoll ({@link OrtProtokoll}, Regel 14).
 *
 * <p><b>Keine zweite Regel-Logik.</b> Jede Regel urteilt {@link OrtsbaumAbleitung} gegen
 * DENSELBEN Baum, den das Lesemodell zeigt ({@link StandortLesemodell#baum}: das Bestehen
 * eines Standorts aus seinen Zeilen, die Intervalle der Gebäude aus {@code ort_zuordnung}):
 * das Ziel besteht an jedem Tag ({@link OrtsbaumAbleitung#eintrag} mit dem neuen Knoten ohne
 * Intervall — PR 661 hat das dem Schreibweg gegeben, der Fremdschlüssel über die Art ist nur
 * die Rückwand), die erlaubten Eltern, die Namensregel unter Geschwistern am Tag
 * ({@link OrtsbaumAbleitung#nameBelegt}), die Fläche ({@link OrtsbaumAbleitung#flaecheEintrag})
 * und die Rückwirkung ({@link OrtsbaumAbleitung#rueckwirkung}). Code, Status und Satz einer
 * Ablehnung sind die des Vertrags. Die Form der Felder prüft {@link OrtFelder}, Kurzzeichen
 * vergibt und prüft {@link OrtKurzzeichen} — über Standorte UND Orte eines Kundenbereichs, nie
 * wiederverwendet; alles drei dieselben Bausteine wie beim Standort (IP-4).
 *
 * <p><b>Die Zeitzone ist die des Standorts</b> (E9, A16): „gültig ab“ fehlend heißt heute
 * dort, und ob ein Eintrag rückwirkend ist, entscheidet der Eintragstag dort. Gebäude und
 * Bereiche tragen keine eigene.
 *
 * <p>Alle Schreibvorgänge eines Kundenbereichs laufen nacheinander (Zeilensperre auf seinem
 * Unternehmen): die Namensregel ist eine Aussage über einen TAG und steht in keinem Index —
 * zwei gleichzeitige „Halle 3“ dürfen nicht beide durchkommen. Der Mandant ist die RLS: ein
 * fremder Standort oder Ort ist nicht da (404, nie 403).
 */
@Service
public class OrtService {

    /** §4.2: ein Strukturobjekt ist mit seinem Namen eingerichtet und sofort aktiv. */
    private static final String ZUSTAND_NEU = "aktiv";
    /** Das Kennzeichen des neuen Knotens im Baum, solange er keine Zeile hat. */
    private static final String NEU = "neu";
    private static final DateTimeFormatter ZEIT = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private final StandortLesemodellService lesemodell;
    private final OrtRepository orte;
    private final OrtZuordnungRepository zuordnungen;
    private final FlaecheRepository flaechen;
    private final OrtKurzzeichen kurzzeichen;
    private final OrtProtokoll protokoll;
    private final JdbcTemplate jdbc;
    private final ObjectProvider<OrtsbaumMessstellen> messstellen;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public OrtService(StandortLesemodellService lesemodell, OrtRepository orte,
            OrtZuordnungRepository zuordnungen, FlaecheRepository flaechen, OrtKurzzeichen kurzzeichen,
            OrtProtokoll protokoll, JdbcTemplate jdbc, ObjectProvider<OrtsbaumMessstellen> messstellen,
            PlatformTransactionManager transactionManager) {
        this.lesemodell = lesemodell;
        this.orte = orte;
        this.zuordnungen = zuordnungen;
        this.flaechen = flaechen;
        this.kurzzeichen = kurzzeichen;
        this.protokoll = protokoll;
        this.jdbc = jdbc;
        this.messstellen = messstellen;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt (A3: „heute ist der 15.01.2027“, A16). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ lesen

    /**
     * Der Ortsbaum zum Stichtag; {@code null} = heute in der Zeitzone des Standorts. Leer = 404.
     * Die Messstellen-Zahl je Knoten kommt aus {@link OrtsbaumMessstellen} (AP-04 IP-7); ohne
     * Bean bleibt sie {@code null}.
     */
    public Optional<OrtsbaumAmStichtag> ortsbaum(UUID standortId, LocalDate stichtag) {
        Zeilen z = lesemodell.zeilen();
        Optional<StandortRepository.Standort> st = z.standorte().stream()
                .filter(s -> s.id().equals(standortId)).findFirst();
        if (st.isEmpty()) {
            return Optional.empty();
        }
        LocalDate tag = stichtag != null
                ? stichtag : uhr.instant().atZone(ZoneId.of(st.get().zeitzone())).toLocalDate();
        OrtsbaumMessstellen quelle = messstellen.getIfAvailable();
        List<OrtsbaumAbleitung.Messstelle> ms = quelle == null ? null : quelle.messstellen();
        // IP-15: ohne Stichtag trägt jeder Knoten, was man HEUTE mit ihm tun kann — auf demselben
        // Baum, auf dem die Schreibrouten urteilen. „Stand am …“ ändert nichts: keine Aktionen.
        OrtAktionen aktionen = stichtag != null ? null
                : new OrtAktionen(StandortService.baum(z, ms == null ? List.of() : ms), tag, orte.mitBezugsgroesse(),
                        orte.mitKennzahl());
        return OrtsbaumLesemodell.ortsbaum(z, standortId, tag, ms, aktionen);
    }

    // ---------------------------------------------------------------- anlegen

    /**
     * Legt ein Gebäude oder einen Bereich an: die Zeile, die Zuordnung ab „gültig ab“, auf
     * Wunsch die erste Fläche ab demselben Tag und EINEN Protokolleintrag. Ohne Kurzzeichen
     * vergibt {@link OrtKurzzeichen} das nächste (G-n, B-n) — in derselben Transaktion; scheitert
     * etwas, rückt auch der Zähler nicht vor. Geprüft wird erst jede Form (400), dann der
     * Vertrag in seiner Reihenfolge, dann Name (409) und Kurzzeichen (409).
     */
    public OrtDto.Ort anlegen(UUID standortId, OrtDto.Anlegen a, ProtokollAkteur wer) {
        OrtArt art = art(a.art());
        String name = OrtFelder.name(a.name(), "name");
        String eigenes = OrtKurzzeichen.form(a.kurzzeichen(), "kurzzeichen");
        List<String> nutzung = OrtFelder.nutzung(a.nutzung(), "nutzung");
        String notiz = OrtFelder.text(a.notiz(), "notiz", OrtFelder.NOTIZ_HOECHSTENS, "Die Notiz");
        if (art == OrtArt.BEREICH && a.baujahr() != null) {
            throw OrtAbgelehnt.anfrage("baujahr", "Ein Bereich hat kein Baujahr — nur ein Gebäude.");
        }
        return mitKurzzeichen(eigenes, null, () -> transaktion.execute(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            StandortRepository.Standort st = z.standorte().stream()
                    .filter(s -> s.id().equals(standortId)).findFirst()
                    .orElseThrow(() -> OrtAbgelehnt.nichtGefunden("Diesen Standort gibt es nicht."));
            UUID tenant = mandant();
            ZoneId zone = ZoneId.of(st.zeitzone());
            Instant jetzt = uhr.instant();
            LocalDate heute = jetzt.atZone(zone).toLocalDate();
            OrtFelder.baujahr(a.baujahr(), "baujahr", heute.getYear());
            LocalDate ab = a.gueltigAb() == null ? heute : a.gueltigAb();
            String eltern = elternKennzeichen(z, st, a.elternId());

            Ortsbaum baum = mitNeuem(StandortLesemodell.baum(z), art, name, List.of());
            EintragErgebnis e = OrtsbaumAbleitung.eintrag(baum,
                    new EintragAntrag(NEU, Vorgang.VERSCHIEBEN, ab, eltern, heute));
            if (!e.erlaubt()) {
                throw abgelehnt(e);
            }
            imStandort(baum, eltern, ab, st);
            nameFrei(z, baum, art, eltern, name, ab, heute, null);
            if (a.flaecheM2() != null) {
                Ortsbaum mitTag = mitNeuem(StandortLesemodell.baum(z), art, name,
                        List.of(new Intervall(ab, null, eltern)));
                FlaecheErgebnis f = OrtsbaumAbleitung.flaecheEintrag(mitTag,
                        new FlaecheAntrag(NEU, ab, a.flaecheM2(), heute));
                if (!f.erlaubt()) {
                    throw abgelehnt(f, "flaecheM2");
                }
            }
            String kz;
            if (eigenes != null) {
                kurzzeichen.pruefeFrei(eigenes, null);
                kz = eigenes;
            } else {
                kz = kurzzeichen.vergeben(tenant, art);
            }

            UUID id = orte.anlegen(new OrtRepository.NeuerOrt(tenant, art.code(), name, kz, nutzung,
                    a.baujahr(), notiz, ZUSTAND_NEU, wer.sub()));
            boolean anStandort = eltern.equals(st.id().toString());
            UUID elternId = UUID.fromString(eltern);
            zuordnungen.zuordnen(tenant, id, anStandort ? elternId : null, anStandort ? null : elternId,
                    ab, null, wer.sub());
            if (a.flaecheM2() != null) {
                flaechen.eintragen(tenant, null, id, a.flaecheM2(), ab, null, wer.sub());
            }
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("name", name);
            neu.put("kurzzeichen", kz);
            neu.put("eltern_art", anStandort ? OrtArt.STANDORT.code() : OrtArt.GEBAEUDE.code());
            neu.put("eltern_id", elternId);
            neu.put("eltern_name", anStandort ? st.name() : ortIn(z, elternId).name());
            nichtLeer(neu, "nutzung", nutzung);
            nichtLeer(neu, "baujahr", a.baujahr());
            nichtLeer(neu, "notiz", notiz);
            nichtLeer(neu, "flaeche_m2", a.flaecheM2());
            protokoll.eintragen(tenant, art.code(), id, "angelegt", null, neu, ab, zone, jetzt, wer);
            return darstellung(lesemodell.zeilen(), id, rueckwirkung(jetzt, ab, null, zone));
        }));
    }

    // ------------------------------------------------------------- bearbeiten

    /**
     * Die einfachen Felder (§4.3): sofort wirksam, Protokoll alt → neu mit „gilt ab“ heute.
     * Ganz — fehlend ist leer; Name und Kurzzeichen sind Pflicht. Ändert sich nichts, gibt es
     * auch keinen Eintrag. Ein archivierter Ort wird nicht bearbeitet (409).
     */
    public OrtDto.Ort bearbeiten(UUID ortId, OrtDto.Bearbeiten b, ProtokollAkteur wer) {
        String name = OrtFelder.name(b.name(), "name");
        String kz = OrtKurzzeichen.form(b.kurzzeichen(), "kurzzeichen");
        if (kz == null) {
            throw OrtAbgelehnt.anfrage("kurzzeichen", "Das Kurzzeichen fehlt.");
        }
        List<String> nutzung = OrtFelder.nutzung(b.nutzung(), "nutzung");
        String notiz = OrtFelder.text(b.notiz(), "notiz", OrtFelder.NOTIZ_HOECHSTENS, "Die Notiz");
        return mitKurzzeichen(kz, ortId, () -> transaktion.execute(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            OrtRepository.Ort o = ortIn(z, ortId);
            Ortsbaum baum = StandortLesemodell.baum(z);
            Instant jetzt = uhr.instant();
            Lage lage = lage(z, baum, ortId, jetzt);
            LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
            if (o.archiviertAm() != null) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("archiviert_am", ZEIT.format(o.archiviertAm().atZone(lage.zone())));
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIERT, o.name() + " ist archiviert. "
                        + "Stellen Sie es zuerst wieder her, um es zu bearbeiten.", fakten);
            }
            OrtArt art = ortArt(o.art());
            if (art == OrtArt.BEREICH && b.baujahr() != null) {
                throw OrtAbgelehnt.anfrage("baujahr", "Ein Bereich hat kein Baujahr — nur ein Gebäude.");
            }
            OrtFelder.baujahr(b.baujahr(), "baujahr", heute.getYear());

            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = new LinkedHashMap<>();
            vergleiche("name", o.name(), name, alt, neu);
            vergleiche("kurzzeichen", o.kurzzeichen(), kz, alt, neu);
            vergleiche("nutzung", o.nutzung(), nutzung, alt, neu);
            vergleiche("baujahr", o.baujahr(), b.baujahr(), alt, neu);
            vergleiche("notiz", o.notiz(), notiz, alt, neu);
            if (neu.isEmpty()) {
                return darstellung(z, ortId, null);
            }
            if (neu.containsKey("name")) {
                nameFrei(z, baum, art, lage.eltern(), name, lage.tag(), lage.tag(), ortId.toString());
            }
            if (neu.containsKey("kurzzeichen")) {
                kurzzeichen.pruefeFrei(kz, ortId);
            }
            if (!orte.bearbeiten(ortId, name, kz, nutzung, b.baujahr(), notiz)) {
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIERT,
                        o.name() + " wurde soeben archiviert.", Map.of());
            }
            protokoll.eintragen(mandant(), art.code(), ortId, "bearbeitet", alt, neu, heute, lage.zone(),
                    jetzt, wer);
            return darstellung(lesemodell.zeilen(), ortId, null);
        }));
    }

    // ----------------------------------------------------------------- Fläche

    /**
     * Die Bezugsfläche ab einem Tag (E3, §5.4): die laufende endet am Vortag, eine am Tag
     * beginnende wird ersetzt (Korrektur, bleibt aufgehoben lesbar) — die Regel ist
     * {@link OrtsbaumAbleitung#flaecheEintrag}, hier werden ihre Intervalle zu Zeilen.
     * Rückwirkend ist erlaubt und steht im Protokoll und in der Antwort (E2, A3).
     */
    public OrtDto.Ort flaecheSetzen(UUID ortId, OrtDto.Flaeche f, ProtokollAkteur wer) {
        if (f.m2() == null) {
            throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.FLAECHE_UNGUELTIG, OrtsbaumAbleitung.FLAECHE_SATZ,
                    Map.of("feld", "m2"));
        }
        return transaktion.execute(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            OrtRepository.Ort o = ortIn(z, ortId);
            Ortsbaum baum = StandortLesemodell.baum(z);
            Instant jetzt = uhr.instant();
            Lage lage = lage(z, baum, ortId, jetzt);
            LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
            LocalDate ab = f.gueltigAb() == null ? heute : f.gueltigAb();
            FlaecheErgebnis e = OrtsbaumAbleitung.flaecheEintrag(baum,
                    new FlaecheAntrag(ortId.toString(), ab, f.m2(), heute));
            if (!e.erlaubt()) {
                throw abgelehnt(e, "m2");
            }
            UUID tenant = mandant();
            anwenden(tenant, ortId, e.flaechen(), jetzt, wer);
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("flaeche_m2", e.vorherM2());
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("flaeche_m2", f.m2());
            neu.put("korrektur", e.korrektur());
            protokoll.eintragen(tenant, o.art(), ortId, "flaeche_geaendert", alt, neu, ab, lage.zone(), jetzt,
                    wer);
            LocalDate bis = e.flaechen().stream().filter(x -> x.ab().equals(ab)).findFirst()
                    .map(FlaechenIntervallMitZustand::bis).orElse(null);
            return darstellung(lesemodell.zeilen(), ortId, rueckwirkung(jetzt, ab, bis, lage.zone()));
        });
    }

    /**
     * Macht aus den Flächen des Urteils Zeilen: eine Zeile, die es so nicht mehr gibt, wird
     * aufgehoben (Korrektur); eine, die früher endet, beendet; eine neue eingetragen — erst
     * alles Beenden, dann das Eintragen (das Überlappungsverbot sieht jeden Zwischenstand).
     */
    // ------------------------------------ archivieren · wiederherstellen · löschen (IP-15)

    /** SQLSTATE, mit dem die Datenbank ein Löschen mit Historie ablehnt (Rückwand und Fremdschlüssel). */
    private static final Set<String> HISTORIE = Set.of("23001", "23503");

    /**
     * Archiviert ein Gebäude oder einen Bereich ab HEUTE in der Zeitzone seines Standorts (Z2, E12):
     * nur ohne aktive Messstelle im Teilbaum und ohne geplante Zuordnung hinein oder heraus — sonst
     * 409 {@code archivieren_gesperrt} mit ALLEN Sperrgründen und dem Satz mit Grund und Weg (Z1, A7),
     * genau wie beim Standort. Leere Bereiche eines Gebäudes gehen mit; jedes laufende Intervall
     * endet am Vortag (begann es heute, wird es aufgehoben — es belegte keinen Tag). Keine Kaskade
     * auf Messstellen. GENAU EIN Protokolleintrag am Ort, der die Mitarchivierten nennt.
     */
    public OrtDto.Ort archivieren(UUID ortId, ProtokollAkteur wer) {
        return transaktion.execute(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            OrtRepository.Ort o = ortIn(z, ortId);
            Instant jetzt = uhr.instant();
            Lage lage = lage(z, StandortLesemodell.baum(z), ortId, jetzt);
            LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
            StandortService.Baum b = StandortService.baum(z, messstellenAmOrt());
            ArchivErgebnis e = OrtsbaumAbleitung.archivieren(b.baum(), o.kurzzeichen(), heute);
            if (!e.erlaubt()) {
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIEREN_GESPERRT, e.text(),
                        Map.of("gruende", e.gruende().stream().map(g -> StandortService.grund(g, b)).toList()));
            }
            List<Map<String, Object>> mit = new ArrayList<>();
            for (Archiviert a : e.archiviert()) {
                OrtRepository.Ort x = b.ort(a.kennzeichen());
                if (!orte.archivieren(x.id(), jetzt, wer.sub()) && x.id().equals(ortId)) {
                    throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.ARCHIVIERT, o.name() + " ist schon archiviert.",
                            Map.of());
                }
                for (OrtZuordnungRepository.Zuordnung iv : z.ortZuordnungen()) {
                    if (iv.ortId().equals(x.id()) && !iv.aufgehoben()
                            && (iv.gueltigBis() == null || !iv.gueltigBis().isBefore(heute))) {
                        if (a.letzterTag().isBefore(iv.gueltigAb())) {
                            zuordnungen.aufheben(iv.id(), jetzt);
                        } else {
                            zuordnungen.beenden(iv.id(), a.letzterTag());
                        }
                    }
                }
                if (!x.id().equals(ortId)) {
                    Map<String, Object> kind = new LinkedHashMap<>();
                    kind.put("id", x.id().toString());
                    kind.put("art", x.art());
                    kind.put("kurzzeichen", x.kurzzeichen());
                    kind.put("name", x.name());
                    mit.add(kind);
                }
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("zustand", o.zustand());
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("zustand", "archiviert");
            neu.put("archiviert_am", ZEIT.format(jetzt.atZone(lage.zone())));
            neu.put("letzter_tag", heute.minusDays(1).toString());
            neu.put("mitarchiviert", mit);
            protokoll.eintragen(mandant(), o.art(), ortId, OrtAenderungRepository.ARCHIVIERT, alt, neu, heute,
                    lage.zone(), jetzt, wer);
            return darstellung(lesemodell.zeilen(), ortId, null);
        });
    }

    /**
     * Holt ein archiviertes Gebäude oder einen archivierten Bereich zurück (Z3, A8): ein NEUES
     * Intervall ab heute an dem Knoten, an dem es zuletzt hing; die Lücke seit dem Archivieren
     * bleibt und wird nie aufgefüllt. Gesperrt (409 {@code wiederherstellen_gesperrt} mit
     * {@code grund}), solange der Elternknoten archiviert ist oder der Name unter den Geschwistern
     * vergeben ist — {@code name} benennt im selben Dialog um. Mitarchivierte Bereiche kommen nicht
     * still mit. Das Kurzzeichen bleibt seins. GENAU EIN Protokolleintrag.
     */
    public OrtDto.Ort wiederherstellen(UUID ortId, StandortDto.Wiederherstellen w, ProtokollAkteur wer) {
        String neuerName = w == null || w.name() == null ? null : OrtFelder.name(w.name(), "name");
        return transaktion.execute(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            OrtRepository.Ort o = ortIn(z, ortId);
            Instant jetzt = uhr.instant();
            Lage lage = lage(z, StandortLesemodell.baum(z), ortId, jetzt);
            LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
            StandortService.Baum b = StandortService.baum(z, messstellenAmOrt());
            WiederherstellErgebnis e =
                    OrtsbaumAbleitung.wiederherstellen(b.baum(), o.kurzzeichen(), heute, neuerName);
            if (!e.erlaubt()) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("grund", e.grund().name().toLowerCase(Locale.ROOT));
                if (e.grund() == WiederherstellGrund.NAME_BELEGT) {
                    String eltern = b.baum().ort(o.kurzzeichen()).orElseThrow().intervalle().stream()
                            .filter(i -> !i.aufgehoben()).reduce((erst, dann) -> dann)
                            .map(Intervall::eltern).orElse(null);
                    OrtsbaumAbleitung.nameBelegt(b.baum(), ortArt(o.art()), eltern,
                            neuerName == null ? o.name() : neuerName, heute, o.kurzzeichen())
                            .map(belegt -> b.ort(belegt.kennzeichen()))
                            .filter(Objects::nonNull)
                            .ifPresent(belegt -> fakten.put("verweis", Map.of("objekt_art", belegt.art(),
                                    "id", belegt.id(), "kurzzeichen", belegt.kurzzeichen(), "name", belegt.name())));
                }
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.WIEDERHERSTELLEN_GESPERRT, e.text(), fakten);
            }
            String eltern = e.intervall().eltern();
            UUID elternStandort = b.standorte().get(eltern);
            OrtRepository.Ort elternOrt = elternStandort == null ? b.ort(eltern) : null;
            if (elternStandort == null && elternOrt == null) {
                throw new IllegalStateException("Elternknoten " + eltern + " von " + ortId + " fehlt im Baum");
            }
            if (!orte.wiederherstellen(ortId, e.name(), ZUSTAND_NEU)) {
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.WIEDERHERSTELLEN_GESPERRT,
                        o.name() + " ist nicht archiviert.", Map.of("grund", "nicht_archiviert"));
            }
            UUID tenant = mandant();
            zuordnungen.zuordnen(tenant, ortId, elternStandort, elternOrt == null ? null : elternOrt.id(), heute,
                    null, wer.sub());
            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = new LinkedHashMap<>();
            alt.put("zustand", "archiviert");
            neu.put("zustand", ZUSTAND_NEU);
            if (!e.name().equals(o.name())) {
                alt.put("name", o.name());
                neu.put("name", e.name());
            }
            neu.put("eltern_art", elternStandort != null ? OrtArt.STANDORT.code() : OrtArt.GEBAEUDE.code());
            neu.put("eltern_id", elternStandort != null ? elternStandort : elternOrt.id());
            Map<String, Object> luecke = null;
            if (e.luecke() != null) {
                luecke = new LinkedHashMap<>();
                luecke.put("von", e.luecke().von().toString());
                luecke.put("bis", e.luecke().bis().toString());
            }
            neu.put("luecke", luecke);
            protokoll.eintragen(tenant, o.art(), ortId, OrtAenderungRepository.WIEDERHERGESTELLT, alt, neu, heute,
                    lage.zone(), jetzt, wer);
            return darstellung(lesemodell.zeilen(), ortId, null);
        });
    }

    /**
     * Löscht ein Gebäude oder einen Bereich OHNE Historie (E1, A9) — endgültig. Das Kurzzeichen
     * bleibt belegt (nie wiederverwendet), die eigenen Protokolleinträge bleiben, und am Knoten, an
     * dem der Ort zuletzt hing, steht „geloescht“ im Protokoll. Mit Historie 409
     * {@code loeschen_gesperrt} mit {@code historie} ({@link OrtAktionen#loeschen}); die Datenbank prüft
     * es in {@code uems_ort_loeschen} noch einmal.
     */
    public void loeschen(UUID ortId, ProtokollAkteur wer) {
        transaktion.executeWithoutResult(tx -> {
            sperre();
            Zeilen z = lesemodell.zeilen();
            OrtRepository.Ort o = ortIn(z, ortId);
            Instant jetzt = uhr.instant();
            Lage lage = lage(z, StandortLesemodell.baum(z), ortId, jetzt);
            LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
            StandortService.Baum b = StandortService.baum(z, messstellenAmOrt());
            OrtAktionen.Loeschen l = OrtAktionen.loeschen(b, o, orte.mitBezugsgroesse(), orte.mitKennzahl());
            if (!l.erlaubt()) {
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.LOESCHEN_GESPERRT, l.text(), Map.of("historie", l.gruende()));
            }
            OrtZuordnungRepository.Zuordnung zuletzt = z.ortZuordnungen().stream()
                    .filter(iv -> iv.ortId().equals(ortId))
                    .max(Comparator.comparing((OrtZuordnungRepository.Zuordnung iv) -> !iv.aufgehoben())
                            .thenComparing(OrtZuordnungRepository.Zuordnung::gueltigAb))
                    .orElse(null);
            try {
                if (!orte.loeschen(ortId)) {
                    throw OrtAbgelehnt.nichtGefunden("Diesen Ort gibt es nicht.");
                }
            } catch (DataAccessException ex) {
                if (HISTORIE.contains(sqlState(ex))) {
                    throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.LOESCHEN_GESPERRT,
                            OrtAktionen.loeschenSatz(o.name(), List.of()), Map.of("historie", List.of()));
                }
                throw ex;
            }
            if (zuletzt != null) {
                Map<String, Object> alt = new LinkedHashMap<>();
                alt.put("art", o.art());
                alt.put("id", o.id().toString());
                alt.put("kurzzeichen", o.kurzzeichen());
                alt.put("name", o.name());
                String elternArt = zuletzt.elternStandortId() != null ? OrtArt.STANDORT.code() : OrtArt.GEBAEUDE.code();
                protokoll.eintragen(mandant(), elternArt, zuletzt.eltern(), "geloescht", alt, null, heute,
                        lage.zone(), jetzt, wer);
            }
        });
    }

    private List<OrtsbaumAbleitung.Messstelle> messstellenAmOrt() {
        return messstellen.getIfAvailable(OrtsbaumMessstellen.Keine::new).messstellen();
    }

    private void anwenden(UUID tenant, UUID ortId, List<FlaechenIntervallMitZustand> soll, Instant jetzt,
            ProtokollAkteur wer) {
        List<FlaecheRepository.Flaeche> ist = flaechen.fuerOrt(ortId).stream()
                .filter(x -> !x.aufgehoben()).toList();
        for (FlaecheRepository.Flaeche r : ist) {
            FlaechenIntervallMitZustand bleibt = soll.stream()
                    .filter(s -> s.ab().equals(r.gueltigAb()) && s.m2() == r.m2())
                    .findFirst().orElse(null);
            if (bleibt == null) {
                flaechen.aufheben(r.id(), jetzt);
            } else if (!Objects.equals(bleibt.bis(), r.gueltigBis())) {
                if (bleibt.bis() == null) {
                    throw new IllegalStateException("eine Fläche wird nie wieder geöffnet: " + r.id());
                }
                flaechen.beenden(r.id(), bleibt.bis());
            }
        }
        for (FlaechenIntervallMitZustand s : soll) {
            boolean da = ist.stream().anyMatch(r -> r.gueltigAb().equals(s.ab()) && r.m2() == s.m2());
            if (!da) {
                flaechen.eintragen(tenant, null, ortId, s.m2(), s.ab(), s.bis(), wer.sub());
            }
        }
    }

    // --------------------------------------------------------------- Urteile

    /** Wo hängt das Neue? Fehlend oder der Standort selbst = direkt am Standort. */
    private static String elternKennzeichen(Zeilen z, StandortRepository.Standort st, UUID elternId) {
        if (elternId == null || elternId.equals(st.id())) {
            return st.id().toString();
        }
        if (z.orte().stream().anyMatch(o -> o.id().equals(elternId))) {
            return elternId.toString();
        }
        if (z.standorte().stream().anyMatch(s -> s.id().equals(elternId))) {
            throw OrtAbgelehnt.anfrage("elternId",
                    "Legen Sie den Ort an dem Standort an, zu dem er gehört.");
        }
        throw OrtAbgelehnt.anfrage("elternId", "Diesen Elternknoten gibt es nicht.");
    }

    /**
     * Das Ziel gehört am ersten Tag zu DIESEM Standort — die Route nennt ihn. Ob es an dem
     * Tag besteht, hat {@link OrtsbaumAbleitung#eintrag} schon geurteilt; wohin es gehört,
     * sagt {@link OrtsbaumAbleitung#standAm}.
     */
    private static void imStandort(Ortsbaum baum, String eltern, LocalDate ab,
            StandortRepository.Standort st) {
        String standort = st.id().toString();
        if (eltern.equals(standort)) {
            return;
        }
        OrtAmStichtag a = OrtsbaumAbleitung.standAm(baum, ab).orte().stream()
                .filter(o -> o.kennzeichen().equals(eltern)).findFirst().orElse(null);
        if (a == null || !standort.equals(a.standort())) {
            String name = baum.ort(eltern).map(OrtsbaumAbleitung.Ort::name).orElse(eltern);
            throw OrtAbgelehnt.anfrage("elternId", name + " gehört am " + OrtsbaumAbleitung.datumText(ab)
                    + " nicht zu " + st.name() + ".");
        }
    }

    /**
     * Regel 13: der Name ist unter den Geschwistern derselben Art am Elternknoten frei — am
     * ersten Tag und, wenn der Ort dann schon besteht, heute. Den Satz baut der Vertrag; der
     * Verweis nennt den Träger mit seinem Kurzzeichen.
     */
    static void nameFrei(Zeilen z, Ortsbaum baum, OrtArt art, String eltern, String name,
            LocalDate ab, LocalDate heute, String ausser) {
        List<LocalDate> tage = heute.isAfter(ab) ? List.of(ab, heute) : List.of(ab);
        for (LocalDate tag : tage) {
            Optional<OrtsbaumAbleitung.Ort> belegt =
                    OrtsbaumAbleitung.nameBelegt(baum, art, eltern, name, tag, ausser);
            if (belegt.isPresent()) {
                OrtRepository.Ort traeger = ortIn(z, UUID.fromString(belegt.get().kennzeichen()));
                OrtsbaumAbleitung.Ort mitKurzzeichen = new OrtsbaumAbleitung.Ort(traeger.kurzzeichen(),
                        belegt.get().art(), belegt.get().name(), null, List.of(), List.of());
                Map<String, Object> verweis = new LinkedHashMap<>();
                verweis.put("objekt_art", traeger.art());
                verweis.put("id", traeger.id());
                verweis.put("kurzzeichen", traeger.kurzzeichen());
                verweis.put("name", traeger.name());
                throw OrtAbgelehnt.von(OrtAbgelehnt.Grund.NAME_BELEGT,
                        OrtsbaumAbleitung.nameBelegtSatz(mitKurzzeichen), Map.of("verweis", verweis));
            }
        }
    }

    /** Die Vertragsgründe beim Anlegen — Code, Status und Satz des Vertrags. */
    private static OrtAbgelehnt abgelehnt(EintragErgebnis e) {
        OrtAbgelehnt.Grund g = switch (e.grund()) {
            case ZIEL_ART_UNZULAESSIG -> OrtAbgelehnt.Grund.ZIEL_ART_UNZULAESSIG;
            case ZIEL_GAB_ES_NOCH_NICHT -> OrtAbgelehnt.Grund.ZIEL_GAB_ES_NOCH_NICHT;
            case ZIEL_ARCHIVIERT -> OrtAbgelehnt.Grund.ZIEL_ARCHIVIERT;
            // Das neue Objekt hat noch kein Intervall: nichts ist vorher, gleich oder bisher.
            default -> throw new IllegalStateException("beim Anlegen unmöglich: " + e.grund());
        };
        return OrtAbgelehnt.von(g, e.text(), Map.of("feld", "elternId"));
    }

    private static OrtAbgelehnt abgelehnt(FlaecheErgebnis e, String feld) {
        OrtAbgelehnt.Grund g = switch (e.grund()) {
            case FLAECHE_UNGUELTIG -> OrtAbgelehnt.Grund.FLAECHE_UNGUELTIG;
            case GAB_ES_NOCH_NICHT -> OrtAbgelehnt.Grund.GAB_ES_NOCH_NICHT;
            case ARCHIVIERT -> OrtAbgelehnt.Grund.ARCHIVIERT;
            case GLEICHE_FLAECHE -> OrtAbgelehnt.Grund.GLEICHE_FLAECHE;
        };
        return OrtAbgelehnt.von(g, e.text(), Map.of("feld", g == OrtAbgelehnt.Grund.FLAECHE_UNGUELTIG
                || g == OrtAbgelehnt.Grund.GLEICHE_FLAECHE ? feld : "gueltigAb"));
    }

    // ------------------------------------------------------------------ Form

    /** Die Art ist Identität (G-/B-Kurzzeichen, Protokoll-Objektart) — nur Gebäude oder Bereich. */
    private static OrtArt art(String roh) {
        if (OrtArt.GEBAEUDE.code().equals(roh)) {
            return OrtArt.GEBAEUDE;
        }
        if (OrtArt.BEREICH.code().equals(roh)) {
            return OrtArt.BEREICH;
        }
        throw OrtAbgelehnt.anfrage("art",
                "Hier entsteht ein Gebäude („gebaeude“) oder ein Bereich („bereich“).");
    }

    // ------------------------------------------------------------------ Hilfen

    /** Wo ein Ort heute hängt — sonst an seinem ersten (geplant) bzw. letzten (archiviert) Tag. */
    record Lage(UUID standortId, ZoneId zone, LocalDate tag, String eltern) {}

    static Lage lage(Zeilen z, Ortsbaum baum, UUID ortId, Instant jetzt) {
        ZoneId vorgabe = z.zeitzone();
        LocalDate heute = jetzt.atZone(vorgabe).toLocalDate();
        List<OrtZuordnungRepository.Zuordnung> w = z.ortZuordnungen().stream()
                .filter(iv -> iv.ortId().equals(ortId) && !iv.aufgehoben())
                .sorted(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigAb))
                .toList();
        if (w.isEmpty()) {
            return new Lage(null, vorgabe, heute, null);
        }
        boolean heuteDa = w.stream().anyMatch(iv -> !iv.gueltigAb().isAfter(heute)
                && (iv.gueltigBis() == null || !heute.isAfter(iv.gueltigBis())));
        LocalDate tag = heuteDa ? heute
                : w.get(0).gueltigAb().isAfter(heute) ? w.get(0).gueltigAb()
                : w.get(w.size() - 1).gueltigBis();
        OrtAmStichtag a = OrtsbaumAbleitung.standAm(baum, tag).orte().stream()
                .filter(o -> o.kennzeichen().equals(ortId.toString())).findFirst().orElse(null);
        if (a == null || a.standort() == null) {
            return new Lage(null, vorgabe, tag, a == null ? null : a.eltern());
        }
        UUID st = UUID.fromString(a.standort());
        ZoneId zone = z.standorte().stream().filter(s -> s.id().equals(st)).findFirst()
                .map(s -> ZoneId.of(s.zeitzone())).orElse(vorgabe);
        return new Lage(st, zone, tag, a.eltern());
    }

    /** Der Baum mit dem neuen Knoten darin — dasselbe Urteil wie für jeden anderen. */
    private static Ortsbaum mitNeuem(Ortsbaum baum, OrtArt art, String name, List<Intervall> intervalle) {
        List<OrtsbaumAbleitung.Ort> orte = new ArrayList<>(baum.orte());
        orte.add(new OrtsbaumAbleitung.Ort(NEU, art, name, null, intervalle, List.of()));
        return new Ortsbaum(baum.zeitzone(), orte, baum.anlagen(), baum.messstellen());
    }

    private OrtDto.Ort darstellung(Zeilen z, UUID ortId, OrtDto.Rueckwirkung rueckwirkung) {
        OrtRepository.Ort o = ortIn(z, ortId);
        Instant jetzt = uhr.instant();
        Lage lage = lage(z, StandortLesemodell.baum(z), ortId, jetzt);
        LocalDate heute = jetzt.atZone(lage.zone()).toLocalDate();
        List<OrtDto.Zuordnung> zu = z.ortZuordnungen().stream()
                .filter(iv -> iv.ortId().equals(ortId) && !iv.aufgehoben())
                .sorted(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigAb))
                .map(iv -> new OrtDto.Zuordnung(iv.eltern(),
                        iv.elternStandortId() != null ? OrtArt.STANDORT.code() : OrtArt.GEBAEUDE.code(),
                        elternName(z, iv), iv.gueltigAb(), iv.gueltigBis(),
                        zustand(iv.gueltigAb(), iv.gueltigBis(), heute)))
                .toList();
        List<OrtDto.FlaechenStand> fl = z.flaechen().stream()
                .filter(f -> ortId.equals(f.ortId()) && !f.aufgehoben())
                .sorted(Comparator.comparing(FlaecheRepository.Flaeche::gueltigAb))
                .map(f -> new OrtDto.FlaechenStand(f.m2(), f.gueltigAb(), f.gueltigBis(),
                        zustand(f.gueltigAb(), f.gueltigBis(), heute)))
                .toList();
        return new OrtDto.Ort(o.id(), o.art(), o.kurzzeichen(), o.name(), o.nutzung(), o.baujahr(),
                o.notiz(), o.zustand(), lage.standortId(), zu, fl, rueckwirkung);
    }

    private static String elternName(Zeilen z, OrtZuordnungRepository.Zuordnung iv) {
        if (iv.elternStandortId() != null) {
            return z.standorte().stream().filter(s -> s.id().equals(iv.elternStandortId())).findFirst()
                    .map(StandortRepository.Standort::name).orElse(null);
        }
        return z.orte().stream().filter(o -> o.id().equals(iv.elternOrtId())).findFirst()
                .map(OrtRepository.Ort::name).orElse(null);
    }

    private static String zustand(LocalDate ab, LocalDate bis, LocalDate heute) {
        return OrtsbaumAbleitung.zuordnungZustand(new Intervall(ab, bis, null), heute).name()
                .toLowerCase(Locale.ROOT);
    }

    /** E2: rückwirkend erlaubt, aber sichtbar — der Eintragstag in der Zeitzone des Standorts. */
    private static OrtDto.Rueckwirkung rueckwirkung(Instant jetzt, LocalDate ab, LocalDate bis, ZoneId zone) {
        RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(
                new RueckwirkungEingang(OffsetDateTime.ofInstant(jetzt, zone), ab, bis, zone, null));
        return new OrtDto.Rueckwirkung(r.art().name().toLowerCase(Locale.ROOT), r.tage(), r.abzeichen());
    }

    private static OrtRepository.Ort ortIn(Zeilen z, UUID id) {
        return z.orte().stream().filter(o -> o.id().equals(id)).findFirst()
                .orElseThrow(() -> OrtAbgelehnt.nichtGefunden("Diesen Ort gibt es nicht."));
    }

    private static OrtArt ortArt(String code) {
        return OrtArt.valueOf(code.toUpperCase(Locale.ROOT));
    }

    private static void vergleiche(String feld, Object alt, Object neu, Map<String, Object> a,
            Map<String, Object> n) {
        if (!Objects.equals(alt, neu)) {
            a.put(feld, alt);
            n.put(feld, neu);
        }
    }

    private static void nichtLeer(Map<String, Object> m, String feld, Object wert) {
        if (wert != null) {
            m.put(feld, wert);
        }
    }

    /** Der Kundenbereich des Aufrufers — unter RLS gibt es ohne ihn keinen Standort und keinen Ort. */
    private static UUID mandant() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt.");
        }
        return tenant;
    }

    /** Alle Schreibvorgänge der Ortsstruktur eines Kundenbereichs nacheinander (Kopf). */
    private void sperre() {
        jdbc.query("SELECT id FROM unternehmen FOR UPDATE", rs -> null);
    }

    /**
     * Die Datenbank ist die Rückwand der Kurzzeichen-Regel: kommt ihr ein gleichzeitiger
     * Schreiber zuvor (23505), urteilt {@link OrtKurzzeichen} nach dem Zurückrollen neu und
     * nennt den Träger (409) — nie ein 500.
     */
    private <T> T mitKurzzeichen(String kandidat, UUID ausser, Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            if (kandidat != null && "23505".equals(sqlState(e))) {
                kurzzeichen.pruefeFrei(kandidat, ausser);
            }
            throw e;
        }
    }

    private static String sqlState(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null) {
                return s.getSQLState();
            }
        }
        return null;
    }
}
