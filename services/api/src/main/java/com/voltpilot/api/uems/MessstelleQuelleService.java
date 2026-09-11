package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraetRepository.SpeisungAm;
import com.voltpilot.api.uems.MessstelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleQuelleRepository.NeueQuelle;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.Abschnitt;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Bindung;
import com.voltpilot.api.uems.MessstelleRegeln.BindungEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BindungUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import com.voltpilot.api.uems.MessstelleRegeln.FremdeFuehrung;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.NeueBindung;
import com.voltpilot.api.uems.MessstelleRegeln.QuelleZeitraum;
import com.voltpilot.api.uems.MessstelleRegeln.Rueckwirkung;
import com.voltpilot.api.uems.MessstelleRegeln.Stand;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.Nebengroesse;
import com.voltpilot.api.web.dto.MesskanalDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Quellenbindung der Messstelle (UEMS AP-04 IP-13): welche Größe ab wann aus welchem
 * Messkanal liest, führend oder zum Vergleich — binden, beenden, lesen. Je Schreibvorgang EINE
 * Transaktion und GENAU EIN Eintrag im Änderungsprotokoll mit Urheber ({@link ProtokollAkteur}).
 *
 * <p><b>Keine zweite Regel-Logik.</b> Ob gebunden oder beendet werden darf, urteilt
 * {@link MessstelleRegeln} ({@code bindungPruefen}, {@code beendenPruefen}); Code und Status einer
 * Ablehnung kommen aus dessen Fehlertabelle. Hier steht, was der Vertrag der Schnittstelle lässt
 * (§10): die Form der Anfrage, das Nachschlagen der Fakten — Messkanal ({@link MesskanalService}),
 * Gerät zum Zeitpunkt ({@link GeraetRepository#speisungAm}), die bestehenden Quellen — und der
 * gespeicherte Zustand (archiviert). Die Datenbank sagt dieselben Verbote noch einmal
 * (V20260911250000); verliert der Schreibweg ein Rennen, urteilt er neu und nennt den Grund.
 *
 * <p><b>Der Messkanal ist Komponente + Gerät + Kanalname.</b> Das Gerät wählt nie der Kunde: es
 * ist der Einbau, der die Komponente zu Beginn der Quelle speist, und die Quelle muss ganz in
 * dieser Speisung liegen — sonst {@code kein_geraet_zum_zeitpunkt}. Ein Zählerwechsel ist ein
 * neuer Messkanal und damit eine neue Quelle (W2).
 *
 * <p><b>Der Beginn der Messstelle</b> ist Mitternacht des ersten Tages ihres ersten Orts (IP-7,
 * {@link MessstelleService#beginn}): keine Quelle beginnt davor ({@code zeitpunkt_vor_vorgaenger}),
 * und der Zeitstrahl beginnt dort — mit einer sichtbaren Lücke bis zur ersten Quelle. Ohne Ort
 * (ein Entwurf) gibt es keinen Beginn; dann prüfen die Regeln ihn nicht, und der Zeitstrahl
 * beginnt mit der ersten Quelle. Die Zeitzone ist die der Messstellen-Schnittstelle
 * ({@link MessstelleService#ZEITZONE}).
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle, Quelle oder Komponente ist 404, nie 403.
 */
@Service
public class MessstelleQuelleService {

    private static final ZoneId ZEITZONE = MessstelleService.ZEITZONE;
    private static final DateTimeFormatter ANZEIGE = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");
    private static final String FUEHREND = "fuehrend";
    private static final String VERGLEICH = "vergleich";
    private static final List<String> ROLLEN = List.of(FUEHREND, VERGLEICH);

    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final GeraetRepository geraete;
    private final MesskanalService messkanaele;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleQuelleService(MessstelleRepository messstellen, MessstelleQuelleRepository quellen,
            MessstelleAenderungRepository aenderungen, MessstelleZuordnungRepository zuordnungen,
            GeraetRepository geraete, MesskanalService messkanaele, JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.aenderungen = aenderungen;
        this.zuordnungen = zuordnungen;
        this.geraete = geraete;
        this.messkanaele = messkanaele;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Nur für Tests: die Uhr, an der „jetzt“ hängt (A1: „eingetragen um 11:05“). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Der Stichtag einer Leseroute: ein Zeitpunkt mit Versatz ({@code 2026-11-18T10:40:00+01:00})
     * oder ein Tag ({@code 2026-11-18}, dann dessen Beginn in der Zeitzone der Schnittstelle);
     * fehlend = {@code jetzt}. Ein „+“, das eine Anfrage-URL zum Leerzeichen gemacht hat, wird
     * wieder ein „+“.
     *
     * @throws DateTimeParseException wenn es weder ein Zeitpunkt noch ein Tag ist
     */
    public static Instant stichtag(String text, Instant jetzt) {
        if (text == null || text.isBlank()) {
            return jetzt;
        }
        String t = text.strip().replace(' ', '+');
        if (t.length() == 10) {
            return LocalDate.parse(t).atStartOfDay(ZEITZONE).toInstant();
        }
        return OffsetDateTime.parse(t).toInstant();
    }

    // ------------------------------------------------------------------ lesen

    /**
     * Je Größe (Hauptgröße zuerst, dann die Nebengrößen) die führende Quelle zum Stichtag
     * ({@code null} = jetzt) — oder
     * keine, nie eine 0 —, die laufenden Vergleichsquellen und der Zeitstrahl der führenden
     * Quellen mit jeder Lücke als eigenem Abschnitt; dazu die ganze Historie.
     */
    public MessstelleQuelleDto.Liste liste(UUID messstelleId, Instant am) {
        Messstelle m = finde(messstelleId);
        List<Nebengroesse> neben = messstellen.nebengroessen(m.id());
        List<Quelle> alle = quellen.derMessstelle(m.id());
        Instant jetzt = uhr.instant();
        Instant stichtag = am == null ? jetzt : am;
        OffsetDateTime beginn = zeit(beginn(m));
        List<MessstelleQuelleDto.GroesseAmStichtag> groessen = new ArrayList<>();
        for (Ziel z : ziele(m, neben)) {
            List<Quelle> derGroesse = alle.stream().filter(q -> z.ist(q.groesse(), q.richtung())).toList();
            List<Quelle> fuehrende = derGroesse.stream().filter(q -> FUEHREND.equals(q.rolle())).toList();
            Quelle fuehrend = fuehrende.stream().filter(q -> gilt(q, stichtag)).findFirst().orElse(null);
            List<MessstelleQuelleDto.Quelle> vergleich = derGroesse.stream()
                    .filter(q -> VERGLEICH.equals(q.rolle()) && gilt(q, stichtag))
                    .map(q -> darstellung(q, jetzt)).toList();
            List<MessstelleQuelleDto.Abschnitt> strahl = new ArrayList<>();
            for (Abschnitt a : MessstelleRegeln.zeitstrahl(beginn, fuehrende.stream()
                    .map(MessstelleQuelleService::zeitraum).toList())) {
                UUID quelle = a.quelle() == null ? null : fuehrende.stream()
                        .filter(q -> zeit(q.gueltigAb()).isEqual(a.von())).findFirst().map(Quelle::id).orElse(null);
                strahl.add(new MessstelleQuelleDto.Abschnitt(a.von(), a.bis(), quelle));
            }
            Groesse g = z.groesse();
            groessen.add(new MessstelleQuelleDto.GroesseAmStichtag(g.groesse(), g.richtung(), g.einheit(),
                    g.wertart(), z.haupt(), z.archiviert() || m.archiviertAm() != null ? "archiviert" : "aktiv",
                    fuehrend == null ? null : darstellung(fuehrend, jetzt), vergleich, strahl));
        }
        return new MessstelleQuelleDto.Liste(m.id(), m.kennzeichen(), zeit(stichtag), groessen,
                alle.stream().map(q -> darstellung(q, jetzt)).toList());
    }

    public MessstelleQuelleDto.Quelle eine(UUID messstelleId, UUID quelleId) {
        finde(messstelleId);
        return darstellung(findeQuelle(messstelleId, quelleId), uhr.instant());
    }

    // ----------------------------------------------------------------- binden

    /**
     * Bindet eine Größe der Messstelle an einen Messkanal. Geprüft wird erst die Form (400), dann
     * der gespeicherte Zustand (archiviert, 409), dann urteilen die Regeln in der Reihenfolge des
     * Vertrags. Eine neue offene führende Quelle beendet die laufende genau zu ihrem Beginn (Regel
     * 2) — in DERSELBEN Transaktion, mit dem Endstand des Vorgängers, und EINEM Protokolleintrag.
     */
    public MessstelleQuelleDto.Vorgang binden(UUID messstelleId, MessstelleQuelleDto.Binden b, ProtokollAkteur wer) {
        return binden(messstelleId, b, wer, null);
    }

    /**
     * Derselbe Weg mit einer HERKUNFT: {@code bestandsuebernahme} für die Vorschlagsliste des
     * Standorts (IP-16, E6) — sie steht an der Bindung und im Protokolleintrag, sonst ändert sie
     * nichts. Von Hand gebunden wird ohne Herkunft ({@code null}).
     */
    MessstelleQuelleDto.Vorgang binden(UUID messstelleId, MessstelleQuelleDto.Binden b, ProtokollAkteur wer,
            String herkunft) {
        Messstelle m = finde(messstelleId);
        Instant jetzt = uhr.instant();
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);

        String rolle = b.rolle();
        if (rolle == null || !ROLLEN.contains(rolle)) {
            throw MessstelleAbgelehnt.anfrage("rolle", "Die Rolle ist „fuehrend“ oder „vergleich“.");
        }
        if (FUEHREND.equals(rolle) && b.zweck() != null) {
            throw MessstelleAbgelehnt.anfrage("zweck", "Einen Zweck hat nur eine Vergleichsquelle.");
        }
        if (b.komponente() == null) {
            throw MessstelleAbgelehnt.anfrage("komponente", "Die Komponente fehlt.");
        }
        if (b.kanal() == null || b.kanal().isBlank()) {
            throw MessstelleAbgelehnt.anfrage("kanal", "Der Messwert (Kanal) fehlt.");
        }
        Instant ab = aufDieMinute(b.gueltigAb(), "gueltig_ab", minute);
        Instant bis = b.gueltigBis() == null ? null : aufDieMinute(b.gueltigBis(), "gueltig_bis", null);
        Stand anfangsstand = stand(b.anfangsstand(), "anfangsstand");
        Stand endstandVorgaenger = stand(b.endstandVorgaenger(), "endstand_vorgaenger");

        List<Nebengroesse> neben = messstellen.nebengroessen(m.id());
        Ziel ziel = ziel(m, neben, b.groesse());
        nichtArchiviert(m);
        if (ziel.archiviert()) {
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, "Die Nebengröße „"
                    + ziel.groesse().groesse() + " · " + ziel.groesse().richtung() + "“ von " + m.kennzeichen()
                    + " ist archiviert — sie bekommt keine neue Quelle.", Map.of());
        }
        Komponente k = komponente(b.komponente());
        MesskanalDto.Messkanal kanal = messkanaele.kanal(k.id(), b.kanal()).orElseThrow(() ->
                MessstelleAbgelehnt.anfrage("kanal", "Den Messwert „" + b.kanal() + "“ liest "
                        + k.anzeige() + " nicht."));

        Pruefung p = pruefen(m, ziel.groesse(), rolle, b.zweck(), k, kanal, ab, bis, anfangsstand,
                endstandVorgaenger, jetzt);
        BindungUrteil u = p.urteil();
        if (u.fehler() != null) {
            throw abgelehnt(u, m, ziel.groesse(), k, kanal, p);
        }
        if (u.beendet() == null && endstandVorgaenger != null) {
            throw MessstelleAbgelehnt.anfrage("endstand_vorgaenger", "Einen Endstand des Vorgängers gibt es nur, "
                    + "wenn die neue Quelle eine laufende beendet.");
        }
        Quelle vorgaenger = u.beendet() == null ? null : zuQuelle(u.beendet().bindung(), p.bestehende());
        SpeisungAm speisung = p.speisung();
        UUID tenant = TenantContext.get();
        UUID id = schreibe(() -> transaktion.execute(s -> {
            if (vorgaenger != null && !quellen.beenden(vorgaenger.id(), ab, repoStand(endstandVorgaenger))) {
                throw soebenVeraendert(m);
            }
            UUID neu = quellen.anlegen(new NeueQuelle(tenant, m.id(), ziel.groesse().groesse(),
                    ziel.groesse().richtung(), k.id(), speisung.einbau().id(), b.kanal(), kanal.wertart(),
                    u.herleitung(), rolle, b.zweck(), ab, bis, repoStand(anfangsstand), u.rueckwirkend(),
                    herkunft, jetzt, wer));
            Map<String, Object> eintrag = new LinkedHashMap<>();
            eintrag.put("quelle_id", neu.toString());
            eintrag.put("groesse", ziel.groesse().groesse());
            eintrag.put("richtung", ziel.groesse().richtung());
            eintrag.put("rolle", rolle);
            eintrag.put("zweck", b.zweck());
            eintrag.put("komponente", k.id().toString());
            eintrag.put("kanal", b.kanal());
            eintrag.put("geraet", speisung.einbau().kennzeichen());
            eintrag.put("einbau", speisung.einbau().einbauKennzeichen());
            eintrag.put("gueltig_ab", iso(ab));
            eintrag.put("gueltig_bis", iso(bis));
            eintrag.put("herleitung", u.herleitung());
            eintrag.put("anfangsstand", standAlsMap(anfangsstand));
            if (herkunft != null) {
                eintrag.put("herkunft", herkunft);
            }
            Map<String, Object> alt = null;
            if (vorgaenger != null) {
                Map<String, Object> beendet = new LinkedHashMap<>();
                beendet.put("quelle_id", vorgaenger.id().toString());
                beendet.put("einbau", vorgaenger.einbau());
                beendet.put("gueltig_bis", iso(ab));
                beendet.put("endstand", standAlsMap(endstandVorgaenger));
                eintrag.put("beendet", beendet);
                Map<String, Object> vorher = new LinkedHashMap<>();
                vorher.put("quelle_id", vorgaenger.id().toString());
                vorher.put("gueltig_bis", null);
                alt = Map.of("beendet", vorher);
            }
            protokoll(m.id(), "quelle_gebunden", alt, eintrag, ab, u.rueckwirkend(), b.grund(), wer, jetzt);
            return neu;
        }), () -> {
            // Ein anderer war schneller (23P01 der Exklusion): mit dem neuen Stand neu urteilen.
            Pruefung neu = pruefen(m, ziel.groesse(), rolle, b.zweck(), k, kanal, ab, bis, anfangsstand,
                    endstandVorgaenger, jetzt);
            return neu.urteil().fehler() == null ? soebenVeraendert(m)
                    : abgelehnt(neu.urteil(), m, ziel.groesse(), k, kanal, neu);
        });
        Quelle gespeichert = findeQuelle(m.id(), id);
        Quelle beendet = vorgaenger == null ? null : findeQuelle(m.id(), vorgaenger.id());
        return new MessstelleQuelleDto.Vorgang(darstellung(gespeichert, jetzt),
                beendet == null ? null : darstellung(beendet, jetzt), rueckwirkung(jetzt, ab), u.hinweise());
    }

    // ---------------------------------------------------------------- beenden

    /**
     * Beendet eine Quelle zu {@code gueltig_bis} (fehlend = jetzt), optional mit dem Endstand. Eine
     * Quelle wird genau einmal beendet; danach bleibt bis zur nächsten Quelle eine sichtbare Lücke.
     */
    public MessstelleQuelleDto.Vorgang beenden(UUID messstelleId, UUID quelleId, MessstelleQuelleDto.Beenden b,
            ProtokollAkteur wer) {
        Messstelle m = finde(messstelleId);
        Quelle q = findeQuelle(m.id(), quelleId);
        Instant jetzt = uhr.instant();
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);
        Instant bis = aufDieMinute(b == null ? null : b.gueltigBis(), "gueltig_bis", minute);
        Stand endstand = stand(b == null ? null : b.endstand(), "endstand");
        BeendenUrteil u = MessstelleRegeln.beendenPruefen(new BeendenEingang(zeit(jetzt), bindung(q), zeit(bis),
                endstand));
        if (u.fehler() != null) {
            throw beendenAbgelehnt(u.fehler(), q);
        }
        schreibe(() -> transaktion.execute(s -> {
            if (!quellen.beenden(q.id(), bis, repoStand(endstand))) {
                throw soebenVeraendert(m);
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("quelle_id", q.id().toString());
            alt.put("gueltig_bis", null);
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("quelle_id", q.id().toString());
            neu.put("einbau", q.einbau());
            neu.put("gueltig_bis", iso(bis));
            neu.put("endstand", standAlsMap(endstand));
            protokoll(m.id(), "quelle_beendet", alt, neu, bis, u.rueckwirkend(), b == null ? null : b.grund(),
                    wer, jetzt);
            return q.id();
        }), () -> {
            Quelle jetztGespeichert = findeQuelle(m.id(), quelleId);
            BeendenUrteil neu = MessstelleRegeln.beendenPruefen(new BeendenEingang(zeit(jetzt),
                    bindung(jetztGespeichert), zeit(bis), endstand));
            return neu.fehler() == null ? soebenVeraendert(m) : beendenAbgelehnt(neu.fehler(), jetztGespeichert);
        });
        return new MessstelleQuelleDto.Vorgang(darstellung(findeQuelle(m.id(), q.id()), jetzt), null,
                rueckwirkung(jetzt, bis), u.hinweise());
    }

    // -------------------------------------------------------- mit dem Archiv

    /**
     * Das Archivieren beendet alle Quellen zum Archivzeitpunkt (AP-04 §4.5 „aktiv → archiviert“) —
     * aber keine wird dafür überschrieben: eine Quelle, die erst NACH dem Archivzeitpunkt beginnt
     * (angekündigt) oder schon ein späteres Ende trägt, lässt sich dort nicht beenden. Dann ist das
     * Archivieren zu diesem Zeitpunkt abgelehnt (409 {@code zustand_passt_nicht}) und nennt sie.
     */
    void archivierbar(Messstelle m, Instant am) {
        for (Quelle q : quellen.derMessstelle(m.id())) {
            boolean endetVorher = q.gueltigBis() != null && !q.gueltigBis().isAfter(am);
            boolean offenUndBegonnen = q.gueltigBis() == null && q.gueltigAb().isBefore(am);
            if (!endetVorher && !offenUndBegonnen) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("quelle_id", q.id().toString());
                fakten.put("gueltig_ab", zeit(q.gueltigAb()));
                fakten.put("gueltig_bis", zeit(q.gueltigBis()));
                throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                        + (q.gueltigAb().isBefore(am)
                                ? " hat eine Quelle (" + q.einbau() + ") bis " + anzeige(q.gueltigBis())
                                        + ". Archivieren Sie frühestens zu diesem Ende"
                                : " hat eine angekündigte Quelle (" + q.einbau() + ") ab "
                                        + anzeige(q.gueltigAb()) + ". Archivieren Sie erst nach ihrem Beginn")
                        + " — eine Quelle wird nie umgeschrieben.", fakten);
            }
        }
    }

    /** Beendet in der laufenden Transaktion jede offene Quelle zum Archivzeitpunkt; liefert ihre Kennungen. */
    List<UUID> zumArchivBeenden(Messstelle m, Instant am) {
        List<UUID> beendet = new ArrayList<>();
        for (Quelle q : quellen.derMessstelle(m.id())) {
            if (q.gueltigBis() == null) {
                if (!quellen.beenden(q.id(), am, null)) {
                    throw soebenVeraendert(m);
                }
                beendet.add(q.id());
            }
        }
        return beendet;
    }

    // ------------------------------------------------------------ Prüfung

    /** Eine Größe der Messstelle: die Hauptgröße oder eine Nebengröße. */
    private record Ziel(Groesse groesse, boolean haupt, boolean archiviert) {
        boolean ist(String groesse, String richtung) {
            return this.groesse.groesse().equals(groesse) && this.groesse.richtung().equals(richtung);
        }
    }

    /** Eine Komponente, wie die App-Rolle sie sieht. */
    private record Komponente(UUID id, UUID siteId, String name) {
        String anzeige() {
            return name == null ? "Die Komponente" : "„" + name + "“";
        }
    }

    /** Alles, woraus das Urteil entstand — für die Sätze der Ablehnung. */
    private record Pruefung(BindungUrteil urteil, List<Quelle> bestehende, List<Quelle> anderswo, SpeisungAm speisung,
            OffsetDateTime beginn) {}

    private Pruefung pruefen(Messstelle m, Groesse ziel, String rolle, String zweck, Komponente k,
            MesskanalDto.Messkanal kanal, Instant ab, Instant bis, Stand anfangsstand, Stand endstandVorgaenger,
            Instant jetzt) {
        SpeisungAm speisung = geraete.speisungAm(k.id(), ab).orElse(null);
        List<Quelle> bestehende = quellen.derMessstelle(m.id());
        List<Quelle> anderswo = quellen.fuehrendAnderswo(k.id(), kanal.kanal(), m.id());
        NeueBindung neu = new NeueBindung(rolle, zweck, k.id().toString(), kanal.kanal(),
                speisung == null ? null : speisung.einbau().kennzeichen(),
                speisung == null ? null : speisung.einbau().einbauKennzeichen(),
                kanal.groesse(), kanal.richtung(), kanal.einheit(), kanal.wertart(), zeit(ab), zeit(bis),
                endstandVorgaenger, anfangsstand, speisung == null ? null : zeit(speisung.gueltigBis()));
        BindungUrteil u = MessstelleRegeln.bindungPruefen(new BindungEingang("binden", zeit(jetzt), m.medium(),
                zeit(beginn(m)), ziel, bestehende.stream().map(MessstelleQuelleService::bindung).toList(), neu,
                anderswo.stream().map(q -> new FremdeFuehrung(q.messstelle(), zeit(q.gueltigAb()),
                        zeit(q.gueltigBis()))).toList()));
        return new Pruefung(u, bestehende, anderswo, speisung, zeit(beginn(m)));
    }

    /** Der Beginn der Messstelle (IP-7): Mitternacht des ersten Tages ihres ersten Orts; {@code null} ohne Ort. */
    private Instant beginn(Messstelle m) {
        return MessstelleService.beginn(zuordnungen.orte(m.id()));
    }

    /** Die Ablehnung eines Bindungs-Urteils: Code und Status des Vertrags, der Satz der Fläche (§5.12). */
    private static MessstelleAbgelehnt abgelehnt(BindungUrteil u, Messstelle m, Groesse ziel, Komponente k,
            MesskanalDto.Messkanal kanal, Pruefung p) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        String satz;
        switch (u.fehler()) {
            case MEDIUM_OHNE_QUELLE -> satz = "Eine Messstelle mit Medium " + m.medium()
                    + " kann keinen Messwert aus dem Katalog binden.";
            case VERGLEICH_OHNE_ZWECK -> satz = "Eine Vergleichsquelle braucht einen Zweck: Plausibilität, "
                    + "Ersatz bei Ausfall oder Abrechnungszähler.";
            case QUELLE_PASST_NICHT -> {
                fakten.put("grund", u.grund());
                fakten.put("kanal", kanalAlsMap(kanal));
                satz = "Der Messwert „" + name(kanal) + "“ kann die Größe „" + ziel.groesse() + " · "
                        + ziel.richtung() + " (" + ziel.wertart() + ")“ nicht liefern: " + passtNicht(u.grund(),
                        ziel, kanal);
            }
            case ZEITRAUM_UNGUELTIG -> satz = "Das Ende muss nach dem Beginn liegen.";
            case KEIN_GERAET_ZUM_ZEITPUNKT -> {
                fakten.put("zeitpunkt", u.ohneGeraetAb());
                fakten.put("komponente", k.id().toString());
                satz = p.speisung() == null
                        ? k.anzeige() + " wird am " + ANZEIGE.format(u.ohneGeraetAb())
                                + " von keinem Gerät gespeist — der Messwert hat dann kein Gerät. Wählen Sie einen "
                                + "Zeitpunkt, zu dem das Gerät eingebaut ist."
                        : k.anzeige() + " wird ab " + ANZEIGE.format(u.ohneGeraetAb()) + " nicht mehr von "
                                + p.speisung().einbau().einbauKennzeichen() + " gespeist. Beenden Sie die Quelle "
                                + "spätestens dann.";
            }
            case KANAL_BEREITS_FUEHREND -> {
                fakten.put("bestehende_messstelle", u.messstelle());
                satz = "Dieser Messwert speist bereits " + u.messstelle() + " (führend). Ein Messwert kann nur "
                        + "eine Messstelle führend speisen — als Vergleichsquelle ist er möglich.";
            }
            case BINDUNG_UEBERLAPPT -> {
                Quelle b = zuQuelle(u.bestehend(), p.bestehende());
                fakten.put("bestehend", quelleAlsMap(b));
                satz = FUEHREND.equals(b.rolle())
                        ? m.kennzeichen() + " hat ab " + anzeige(b.gueltigAb()) + " bereits eine führende Quelle ("
                                + b.einbau() + "). Beenden Sie diese oder wählen Sie einen anderen Zeitpunkt."
                        : m.kennzeichen() + " hat diesen Messwert ab " + anzeige(b.gueltigAb())
                                + " bereits als Vergleichsquelle.";
            }
            case ZEITPUNKT_VOR_VORGAENGER -> satz = "Der Zeitpunkt liegt vor dem Beginn von " + m.kennzeichen()
                    + " (ihr erster Ort gilt ab " + ANZEIGE.format(p.beginn()) + "). Wählen Sie einen späteren "
                    + "Zeitpunkt.";
            default -> satz = "Diese Quelle lässt sich so nicht binden.";
        }
        return MessstelleAbgelehnt.regel(u.fehler(), satz, fakten);
    }

    private static String passtNicht(String grund, Groesse ziel, MesskanalDto.Messkanal kanal) {
        return switch (grund) {
            case "wertart" -> kanal.wertart() == null
                    ? "er hat keine Wertart, aus der sich die Größe bilden ließe."
                    : "ein " + wertartWort(kanal.wertart()) + " liefert keinen " + ziel.wertart() + ".";
            case "groesse" -> "er misst " + (kanal.groesse() == null ? "keine Messgröße" : kanal.groesse())
                    + ", nicht " + ziel.groesse() + ".";
            case "einheit" -> "seine Einheit " + kanal.einheit() + " lässt sich nicht in " + ziel.einheit()
                    + " umrechnen.";
            case "richtung" -> kanal.richtung() == null
                    ? "er misst Bezug und Abgabe in einem Wert mit Vorzeichen. Getrennt nach Richtung lässt er "
                            + "sich noch nicht binden."
                    : "er misst " + kanal.richtung() + ", nicht " + ziel.richtung() + ".";
            default -> "er passt nicht zur Größe.";
        };
    }

    private static String wertartWort(String wertart) {
        return switch (wertart) {
            case "counter" -> "Zählerstand";
            case "gauge" -> "Momentanwert";
            default -> "Zustand";
        };
    }

    private MessstelleAbgelehnt beendenAbgelehnt(Fehler f, Quelle q) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("gueltig_ab", zeit(q.gueltigAb()));
        fakten.put("gueltig_bis", zeit(q.gueltigBis()));
        String satz = f == Fehler.BINDUNG_BEREITS_BEENDET
                ? "Diese Quelle ist seit " + anzeige(q.gueltigBis()) + " beendet. Eine Quelle wird nur einmal "
                        + "beendet — binden Sie für die Zeit danach eine neue."
                : "Das Ende muss nach dem Beginn (" + anzeige(q.gueltigAb()) + ") liegen.";
        return MessstelleAbgelehnt.regel(f, satz, fakten);
    }

    private static MessstelleAbgelehnt soebenVeraendert(Messstelle m) {
        return MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT,
                "Die Quellen von " + m.kennzeichen() + " wurden soeben verändert. Laden Sie neu und prüfen Sie "
                        + "Ihre Eingabe.", Map.of());
    }

    // ------------------------------------------------------------ Gerüst

    private Messstelle finde(UUID id) {
        return messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private Quelle findeQuelle(UUID messstelleId, UUID id) {
        return quellen.eine(messstelleId, id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Quelle nicht gefunden."));
    }

    /** Eine fremde oder unbekannte Komponente ist nicht da (404, nie 403). */
    private Komponente komponente(UUID id) {
        return jdbc.query("SELECT id, site_id, label FROM measurement_point WHERE id = ?",
                (rs, n) -> new Komponente(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                        rs.getString("label")), id).stream().findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden."));
    }

    private static void nichtArchiviert(Messstelle m) {
        if (m.archiviertAm() != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("archiviert_am", zeit(m.archiviertAm()));
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                    + " ist seit " + anzeige(m.archiviertAm()) + " archiviert — eine archivierte Messstelle "
                    + "bekommt keine neue Quelle.", fakten);
        }
    }

    /** Die Hauptgröße zuerst, dann die Nebengrößen in ihrer Reihenfolge. */
    private static List<Ziel> ziele(Messstelle m, List<Nebengroesse> neben) {
        List<Ziel> z = new ArrayList<>();
        z.add(new Ziel(m.hauptgroesse(), true, false));
        neben.forEach(n -> z.add(new Ziel(n.groesse(), false, n.archiviertAm() != null)));
        return z;
    }

    private static Ziel ziel(Messstelle m, List<Nebengroesse> neben, MessstelleQuelleDto.GroesseWahl wahl) {
        if (wahl == null) {
            return ziele(m, neben).get(0);
        }
        return ziele(m, neben).stream().filter(z -> z.ist(wahl.groesse(), wahl.richtung())).findFirst()
                .orElseThrow(() -> MessstelleAbgelehnt.anfrage("groesse", m.kennzeichen() + " hat keine Größe „"
                        + wahl.groesse() + " · " + wahl.richtung() + "“."));
    }

    /** Ein Zeitpunkt der Anfrage: auf die Minute (E2), fehlend = die Vorgabe. */
    private static Instant aufDieMinute(OffsetDateTime z, String feld, Instant vorgabe) {
        if (z == null) {
            if (vorgabe == null) {
                throw MessstelleAbgelehnt.anfrage(feld, "Der Zeitpunkt fehlt.");
            }
            return vorgabe;
        }
        if (z.getSecond() != 0 || z.getNano() != 0) {
            throw MessstelleAbgelehnt.anfrage(feld, "Der Zeitpunkt gilt auf die Minute — ohne Sekunden.");
        }
        return z.toInstant();
    }

    private static Stand stand(MessstelleQuelleDto.Stand s, String feld) {
        if (s == null) {
            return null;
        }
        if (s.wert() == null || s.wert().isNaN() || s.wert().isInfinite()) {
            throw MessstelleAbgelehnt.anfrage(feld + ".wert", "Ein Ablesestand braucht einen Wert.");
        }
        return new Stand(s.wert(), s.einheit() == null || s.einheit().isBlank() ? null : s.einheit().strip());
    }

    private static MessstelleQuelleRepository.Stand repoStand(Stand s) {
        return s == null ? null : new MessstelleQuelleRepository.Stand(s.wert(), s.einheit());
    }

    private static Bindung bindung(Quelle q) {
        return new Bindung(q.rolle(), q.groesse(), q.richtung(), q.entityId().toString(), q.kanal(), q.geraet(),
                q.einbau(), q.kanalWertart(), q.zweck(), zeit(q.gueltigAb()), zeit(q.gueltigBis()));
    }

    private static QuelleZeitraum zeitraum(Quelle q) {
        return new QuelleZeitraum(q.entityId().toString(), q.kanal(), q.geraet(), q.einbau(), zeit(q.gueltigAb()),
                zeit(q.gueltigBis()));
    }

    /** Die gespeicherte Quelle zu einer Bindung des Urteils (die Regeln sprechen in Kennzeichen). */
    private static Quelle zuQuelle(Bindung b, List<Quelle> alle) {
        return alle.stream().filter(q -> q.rolle().equals(b.rolle()) && q.groesse().equals(b.groesse())
                        && q.richtung().equals(b.richtung()) && q.entityId().toString().equals(b.komponente())
                        && q.kanal().equals(b.kanal()) && Objects.equals(q.einbau(), b.einbau())
                        && zeit(q.gueltigAb()).isEqual(b.gueltigAb()))
                .findFirst().orElseThrow(() -> new IllegalStateException("Quelle des Urteils nicht gefunden"));
    }

    /** Läuft die Bindung zum Zeitpunkt? Beginn eingeschlossen, Ende ausgeschlossen — auch die Regel des Registers. */
    static boolean gilt(Quelle q, Instant t) {
        return !q.gueltigAb().isAfter(t) && (q.gueltigBis() == null || q.gueltigBis().isAfter(t));
    }

    private static MessstelleQuelleDto.Quelle darstellung(Quelle q, Instant jetzt) {
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);
        String status = q.gueltigAb().isAfter(minute) ? "geplant"
                : q.gueltigBis() == null || q.gueltigBis().isAfter(minute) ? "gilt" : "beendet";
        return new MessstelleQuelleDto.Quelle(q.id(), q.messstelleId(), q.groesse(), q.richtung(), q.rolle(),
                q.zweck(), q.entityId(), q.komponenteName(), q.siteId(), q.kanal(), q.kanalWertart(), q.herleitung(),
                new MessstelleQuelleDto.Geraet(q.geraetId(), q.geraet(), q.einbau()), zeit(q.gueltigAb()),
                zeit(q.gueltigBis()), status, dtoStand(q.anfangsstand()), dtoStand(q.endstand()), q.rueckwirkend(),
                q.herkunft(), zeit(q.eingetragenAm()), q.eingetragenVon());
    }

    private static MessstelleQuelleDto.Stand dtoStand(MessstelleQuelleRepository.Stand s) {
        return s == null ? null : new MessstelleQuelleDto.Stand(s.wert(), s.einheit());
    }

    private static MessstelleQuelleDto.Rueckwirkung rueckwirkung(Instant jetzt, Instant zeitpunkt) {
        Rueckwirkung r = MessstelleRegeln.rueckwirkung(zeit(jetzt), zeit(zeitpunkt));
        return new MessstelleQuelleDto.Rueckwirkung(r.art(), r.minuten(), r.abzeichen());
    }

    private static String name(MesskanalDto.Messkanal k) {
        return k.anzeigename() == null ? k.kanal() : k.anzeigename();
    }

    private static Map<String, Object> kanalAlsMap(MesskanalDto.Messkanal k) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kanal", k.kanal());
        m.put("anzeigename", k.anzeigename());
        m.put("groesse", k.groesse());
        m.put("richtung", k.richtung());
        m.put("einheit", k.einheit());
        m.put("wertart", k.wertart());
        m.put("direction", k.direction());
        return m;
    }

    private static Map<String, Object> quelleAlsMap(Quelle q) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("quelle_id", q.id().toString());
        m.put("rolle", q.rolle());
        m.put("einbau", q.einbau());
        m.put("kanal", q.kanal());
        m.put("gueltig_ab", zeit(q.gueltigAb()));
        m.put("gueltig_bis", zeit(q.gueltigBis()));
        return m;
    }

    private static Map<String, Object> standAlsMap(Stand s) {
        if (s == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("wert", s.wert());
        m.put("einheit", s.einheit());
        return m;
    }

    /**
     * Schreibt und fängt das eine Rennen, das die Prüfung vorher nicht ausschließen kann: ein
     * anderer schreibt zwischen Prüfung und Schreiben eine überlappende Quelle. Die Datenbank lehnt
     * mit 23P01 ab; nach dem Zurückrollen urteilt {@code neuUrteilen} und nennt den Grund.
     */
    private static <T> T schreibe(Supplier<T> arbeit, Supplier<MessstelleAbgelehnt> neuUrteilen) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            if ("23P01".equals(sqlState(e))) {
                throw neuUrteilen.get();
            }
            throw e;
        }
    }

    private void protokoll(UUID messstelle, String art, Map<String, Object> alt, Map<String, Object> neu,
            Instant giltAb, boolean rueckwirkend, String grund, ProtokollAkteur wer, Instant jetzt) {
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), messstelle, art, alsJson(alt), alsJson(neu),
                giltAb, rueckwirkend, grund == null || grund.isBlank() ? null : grund, wer.sub(), wer.name(),
                wer.rolle(), wer.art()), jetzt);
    }

    private String alsJson(Map<String, Object> werte) {
        if (werte == null) {
            return null;
        }
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, ZEITZONE);
    }

    /** Ein Zeitpunkt in der Form des Vertrags ({@code 2026-11-18T10:40:00+01:00}). */
    private static String iso(Instant t) {
        return t == null ? null : DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zeit(t));
    }

    private static String anzeige(Instant t) {
        return t == null ? "—" : ANZEIGE.format(zeit(t));
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
