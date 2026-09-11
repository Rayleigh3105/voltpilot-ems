package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EinstellungAbgelehnt.Schnittstelle;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.GeraetRepository.Einbau;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Abgeleitet;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Art;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Bestehende;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Eingang;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Fehler;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Neu;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Urteil;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Vorgaenger;
import com.voltpilot.api.uems.QuelleEinstellungRepository.Fassung;
import com.voltpilot.api.uems.QuelleEinstellungRepository.NeueFassung;
import com.voltpilot.api.uems.QuelleEinstellungRepository.Speisung;
import com.voltpilot.api.web.dto.EinstellungDto;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11): lesen, eintragen, und der Hebel-Weg.
 * Jede Regel urteilt {@link QuelleEinstellungRegeln}; hier wird gelesen, gesperrt und geschrieben.
 *
 * <p><b>Kein gespeicherter Wert ändert sich (E5).</b> Diese Klasse schreibt nur
 * {@code quelle_einstellung} und das Protokoll an jeder Messstelle, die die Quelle speist
 * ({@code messstelle_aenderung}, Art {@code einstellung_geaendert}). Sie ändert keine Verbindung, keine
 * Komponenten-Fassung, keine Messreihe und stellt nichts an die Box zu — eine angewendete
 * Eintragung bleibt „Zustellung ausstehend", bis AP-06 zustellt.
 *
 * <p><b>Der Hebel-Weg (W5).</b> {@link #verbindungGeaendert} läuft im PUT der Komponente, BEVOR
 * deren Verbindung geschrieben wird: erst sichert er die Fassung 1 aus der bisherigen Verbindung
 * (dieselbe SQL-Regel wie die Bestands-Ableitung), dann schreibt er für jede geänderte Einstellung
 * eine Fassung „angewendet, gültig ab jetzt". Er lehnt fachlich nie etwas ab — und er läuft in einem
 * EIGENEN Savepoint ({@link Propagation#NESTED}): scheitert er doch (eine Ausnahme der Datenbank),
 * rollt nur der Savepoint zurück, der Aufrufer fängt die Ausnahme, meldet sie über
 * {@link #fehlgeschlagen} (Log + Zähler {@code voltpilot_einstellung_fassung_total{ergebnis="fehler"}})
 * und schreibt die Komponente genau wie vorher.
 */
@Service
public class QuelleEinstellungService {

    private static final Logger log = LoggerFactory.getLogger(QuelleEinstellungService.class);

    /** Die Begründung, die der Hebel-Weg an seine Fassungen schreibt. */
    static final String GRUND_VERBINDUNG = "Verbindung der Komponente geändert";

    /** So oft rückt der Hebel-Weg eine Minute weiter, wenn die laufende schon belegt ist. */
    private static final int HEBEL_VERSUCHE = 5;

    /** Der Zähler des Hebel-Wegs (Prometheus: {@code voltpilot_einstellung_fassung_total}), Tag {@code ergebnis}. */
    static final String ZAEHLER = "voltpilot_einstellung_fassung";

    /** Die Art des Eintrags im Protokoll der Messstelle (CHECK in V20260911280000). */
    static final String PROTOKOLL_ART = "einstellung_geaendert";

    private final QuelleEinstellungRepository fassungen;
    private final GeraetRepository geraete;
    private final MessstelleAenderungRepository protokoll;
    private final ObjectMapper json;
    private final Counter fehler;
    private volatile Clock uhr = Clock.systemUTC();

    public QuelleEinstellungService(QuelleEinstellungRepository fassungen, GeraetRepository geraete,
            MessstelleAenderungRepository protokoll, ObjectMapper json, MeterRegistry metriken) {
        this.fassungen = fassungen;
        this.geraete = geraete;
        this.protokoll = protokoll;
        this.json = json;
        this.fehler = Counter.builder(ZAEHLER)
                .description("Einstellungs-Fassungen des Hebel-Wegs im PUT der Komponente, die nicht "
                        + "geschrieben werden konnten (die Komponente wurde trotzdem gespeichert)")
                .tag("ergebnis", "fehler")
                .register(metriken);
    }

    /** Für Tests: die Uhr, an der „jetzt", „rückwirkend" und der Stichtag hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- Lesen

    /** Die Historie des Einbaus und je Quelle und Art die zum Stichtag gültige Fassung. */
    @Transactional(readOnly = true)
    public EinstellungDto.Einstellungen einstellungen(UUID geraetId, Instant stichtag) {
        Einbau e = einbau(geraetId);
        Instant jetzt = uhr.instant();
        Instant t = stichtag == null ? jetzt : stichtag;
        List<Fassung> alle = new ArrayList<>(fassungen.desEinbaus(geraetId));
        alle.sort(REIHENFOLGE);
        List<EinstellungDto.Fassung> gueltig = alle.stream()
                .filter(f -> !f.gueltigAb().isAfter(t) && (f.gueltigBis() == null || t.isBefore(f.gueltigBis())))
                .map(f -> dto(f, jetzt)).toList();
        return new EinstellungDto.Einstellungen(e.id(), e.kennzeichen(), e.einbauKennzeichen(), zeit(t), gueltig,
                alle.stream().map(f -> dto(f, jetzt)).toList());
    }

    // ---------------------------------------------------------------- Eintragen

    /**
     * Trägt eine neue Fassung ein: sie beendet die zu ihrem Beginn gültige derselben Quelle und Art
     * genau dort und gilt bis zur nächsten späteren. Protokoll an der Quelle (die Fassung selbst) und
     * an jeder Messstelle, deren Quellenbindung zu ihrem Beginn aus der Quelle liest.
     */
    @Transactional
    public EinstellungDto.Eingetragen eintragen(UUID geraetId, EinstellungDto.Neu antrag, ProtokollAkteur akteur) {
        Einbau e = einbau(geraetId);
        pruefeForm(antrag);
        fassungen.sperreEinbau(geraetId);
        Instant ab = antrag.gueltigAb().toInstant();
        Instant tatsaechlich = antrag.tatsaechlichAb() == null ? null : antrag.tatsaechlichAb().toInstant();
        String kanal = antrag.kanal() == null ? null : antrag.kanal().strip();

        Instant beginn = e.eingebautAm();
        Instant ende = e.ausgebautAm();
        if (antrag.entityId() != null) {
            List<GeraetRepository.Speisung> sp = geraete.speisungenDes(geraetId).stream()
                    .filter(s -> s.entityId().equals(antrag.entityId())).toList();
            if (sp.isEmpty()) {
                throw EinstellungAbgelehnt.schnittstelle(Schnittstelle.KEINE_SPEISUNG,
                        "Diese Komponente wird von diesem Gerät nicht gespeist — ihre Einstellungen stehen am "
                                + "Gerät, das sie misst.", Map.of("entity_id", antrag.entityId().toString()));
            }
            GeraetRepository.Speisung s = sp.stream()
                    .filter(x -> !x.gueltigAb().isAfter(ab) && (x.gueltigBis() == null || ab.isBefore(x.gueltigBis())))
                    .findFirst().orElse(ab.isBefore(sp.get(0).gueltigAb()) ? sp.get(0) : sp.get(sp.size() - 1));
            beginn = s.gueltigAb();
            ende = s.gueltigBis();
        }

        Instant jetzt = uhr.instant();
        List<Fassung> vorhanden = fassungen.derQuelle(geraetId, antrag.entityId(), kanal, antrag.art());
        Urteil u = QuelleEinstellungRegeln.neueFassung(new Eingang(beginn, ende, bestehende(vorhanden),
                new Neu(antrag.art(), antrag.wert(), antrag.anwendung(), ab, tatsaechlich), jetzt));
        if (!u.ok()) {
            throw abgelehnt(u.fehler(), antrag, beginn, ende, vorhanden);
        }
        if (u.beendet() != null) {
            fassungen.beenden(UUID.fromString(u.beendet().id()), u.beendet().gueltigBis());
        }
        UUID id = fassungen.anlegen(new NeueFassung(TenantContext.get(), geraetId, antrag.entityId(), kanal,
                antrag.art(), antrag.wert(), antrag.anwendung(),
                QuelleEinstellungRegeln.EINTRAG, ab, u.gueltigBis(), tatsaechlich, u.rueckwirkend(),
                begruendung(antrag.begruendung()), akteur, jetzt));
        Fassung neu = fassungen.eine(id).orElseThrow();
        Fassung beendet = u.beendet() == null ? null
                : fassungen.eine(UUID.fromString(u.beendet().id())).orElse(null);
        List<String> protokolliert = anMessstellenProtokollieren(e, neu, vorgaengerVon(u, vorhanden), akteur, jetzt);
        Vorgaenger vorgaenger = u.vorgaenger() == null ? null
                : new Vorgaenger(u.vorgaenger().wert(), u.vorgaenger().anwendung());
        List<String> folgen = QuelleEinstellungRegeln.folgen(antrag.art(), QuelleEinstellungRegeln.EINTRAG,
                antrag.wert(), antrag.anwendung(), ab, tatsaechlich, vorgaenger);
        return new EinstellungDto.Eingetragen(dto(neu, jetzt), beendet == null ? null : dto(beendet, jetzt),
                folgen, protokolliert);
    }

    // ---------------------------------------------------------------- Hebel-Weg

    /**
     * Der Hebel „Auf ×10 stellen" (W5) und jede andere Änderung derselben Verbindungsfelder: ändert
     * der PUT der Komponente eine Einstellung ihrer Verbindung, steht danach eine Fassung
     * „angewendet, gültig ab jetzt" mit Protokoll da — in derselben Transaktion. Aufzurufen, BEVOR
     * die neue Verbindung geschrieben ist: die Fassung 1 kommt aus der bisherigen.
     *
     * <p>Lehnt nie ab: was die Regeln hier nicht zulassen (die Quelle begann erst in dieser Minute,
     * dieselbe Einstellung gilt schon), wird nicht geschrieben und protokolliert — das Setzen des
     * Werts und die Testpflicht bleiben genau, wie sie waren.
     *
     * <p>⚠ {@link Propagation#NESTED}, nicht REQUIRED: in der Transaktion des PUT hätte jede Ausnahme
     * hier (ein CHECK, eine Exklusion, ein Trigger, das Protokoll) die GEMEINSAME Transaktion
     * rollback-only gemacht — und damit die Änderung des Kunden scheitern lassen, auch wenn der
     * Aufrufer sie fängt. Im Savepoint rollt nur dieser Teil zurück, die Verbindung der Datenbank ist
     * danach wieder benutzbar, und der Aufrufer ({@code ComponentService.update}) fängt, meldet
     * ({@link #fehlgeschlagen}) und macht weiter.
     */
    @Transactional(propagation = Propagation.NESTED)
    public void verbindungGeaendert(UUID entityId, String kommunikation, String verbindungAlt,
            String verbindungNeu, String subject) {
        if (Objects.equals(verbindungAlt, verbindungNeu)) {
            return;
        }
        List<Abgeleitet> geaendert = QuelleEinstellungRegeln.aenderungen(kommunikation, lies(verbindungAlt),
                lies(verbindungNeu));
        if (geaendert.isEmpty()) {
            return;
        }
        Optional<Speisung> speisung = fassungen.laufendeSpeisung(entityId);
        if (speisung.isEmpty()) {
            log.warn("Einstellung der Komponente {} geändert, aber kein Gerät speist sie — keine Fassung", entityId);
            return;
        }
        UUID geraetId = speisung.get().geraetId();
        Einbau einbau = einbau(geraetId);
        fassungen.sperreEinbau(geraetId);
        fassungen.fassungEinsAbleiten(entityId);
        ProtokollAkteur akteur = akteur(subject);
        Instant jetzt = uhr.instant();
        for (Abgeleitet a : geaendert) {
            List<Fassung> vorhanden = fassungen.derQuelle(geraetId, entityId, a.kanal(), a.art());
            Instant ab = jetzt.truncatedTo(ChronoUnit.MINUTES);
            Urteil u = null;
            for (int versuch = 0; versuch < HEBEL_VERSUCHE; versuch++) {
                u = QuelleEinstellungRegeln.neueFassung(new Eingang(speisung.get().gueltigAb(), null,
                        bestehende(vorhanden), new Neu(a.art(), a.wert(), QuelleEinstellungRegeln.ANGEWENDET, ab, null),
                        jetzt));
                if (u.fehler() != Fehler.BEGINN_BELEGT) {
                    break;
                }
                // Zweimal in derselben Minute: die neue gilt ab der nächsten.
                ab = ab.plus(1, ChronoUnit.MINUTES);
            }
            if (!u.ok()) {
                log.info("Keine Fassung für {} {} der Komponente {}: {}", a.art(), a.kanal(), entityId,
                        u.fehler().code());
                continue;
            }
            if (u.beendet() != null) {
                fassungen.beenden(UUID.fromString(u.beendet().id()), u.beendet().gueltigBis());
            }
            UUID id = fassungen.anlegen(new NeueFassung(TenantContext.get(), geraetId, entityId, a.kanal(), a.art(),
                    a.wert(), QuelleEinstellungRegeln.ANGEWENDET, QuelleEinstellungRegeln.VERBINDUNG, ab,
                    u.gueltigBis(), null, u.rueckwirkend(), GRUND_VERBINDUNG, akteur, jetzt));
            anMessstellenProtokollieren(einbau, fassungen.eine(id).orElseThrow(), vorgaengerVon(u, vorhanden),
                    akteur, jetzt);
        }
    }

    /**
     * Meldet einen gescheiterten Hebel-Weg: laut ins Log (Komponente und die geänderten Arten) und
     * in den Zähler {@code voltpilot_einstellung_fassung_total{ergebnis="fehler"}}. Wirft nie — der
     * Aufrufer schreibt danach die Komponente weiter wie bisher.
     */
    public void fehlgeschlagen(UUID entityId, String kommunikation, String verbindungAlt, String verbindungNeu,
            RuntimeException ursache) {
        List<String> arten;
        try {
            arten = QuelleEinstellungRegeln.aenderungen(kommunikation, lies(verbindungAlt), lies(verbindungNeu))
                    .stream().map(a -> a.kanal() == null ? a.art() : a.art() + "@" + a.kanal()).toList();
        } catch (RuntimeException e) {
            arten = List.of("?");
        }
        log.error("Einstellungs-Fassung der Komponente {} NICHT geschrieben (Arten {}) — die Komponente wird "
                + "trotzdem gespeichert: {}", entityId, arten, ursache.toString(), ursache);
        fehler.increment();
    }

    // ---------------------------------------------------------------- Gerüst

    /** Nach Quelle (Einbau zuerst, dann Komponente, dann Kanal), Art (Reihenfolge des Vertrags), Beginn. */
    private static final Comparator<Fassung> REIHENFOLGE = Comparator
            .comparing((Fassung f) -> f.entityId() == null ? "" : f.entityId().toString())
            .thenComparing(f -> f.kanal() == null ? "" : f.kanal())
            .thenComparing(f -> Art.von(f.art()) == null ? Integer.MAX_VALUE : Art.von(f.art()).ordinal())
            .thenComparing(Fassung::gueltigAb);

    private Einbau einbau(UUID geraetId) {
        return geraete.eines(geraetId).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));
    }

    private static void pruefeForm(EinstellungDto.Neu a) {
        if (a == null) {
            throw EinstellungAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.art() == null || Art.von(a.art()) == null) {
            throw EinstellungAbgelehnt.anfrage("art", "„art“ ist eine der Arten des Vertrags (etwa "
                    + "„wandler_strom“ oder „skalierung“).");
        }
        if (a.anwendung() == null || !QuelleEinstellungRegeln.ANWENDUNGEN.contains(a.anwendung())) {
            throw EinstellungAbgelehnt.anfrage("anwendung", "„anwendung“ ist „angewendet“ oder „dokumentiert“.");
        }
        if (a.wert() == null || a.wert().isNull()) {
            throw EinstellungAbgelehnt.anfrage("wert", "„wert“ fehlt.");
        }
        if (a.gueltigAb() == null) {
            throw EinstellungAbgelehnt.anfrage("gueltig_ab", "„gueltig_ab“ fehlt — ab wann gilt die Einstellung?");
        }
        if (a.kanal() != null && (a.entityId() == null || a.kanal().isBlank() || a.kanal().strip().length() > 240)) {
            throw EinstellungAbgelehnt.anfrage("kanal", "Ein Kanal gehört zu einer Komponente — dazu fehlt "
                    + "„entity_id“, oder der Kanalname ist leer oder zu lang.");
        }
        if (a.begruendung() != null && a.begruendung().strip().length() > 500) {
            throw EinstellungAbgelehnt.anfrage("begruendung", "Die Begründung hat höchstens 500 Zeichen.");
        }
    }

    private EinstellungAbgelehnt abgelehnt(Fehler f, EinstellungDto.Neu a, Instant beginn, Instant ende,
            List<Fassung> vorhanden) {
        Art art = Art.von(a.art());
        Map<String, Object> fakten = new LinkedHashMap<>();
        String satz;
        switch (f) {
            case WERT_UNGUELTIG -> {
                fakten.put("art", a.art());
                fakten.put("felder", art.felder());
                satz = "Der Wert passt nicht zur Art „" + art.kundenwort() + "“: erwartet werden genau die Felder "
                        + String.join(", ", art.felder()) + (art == Art.SKALIERUNG ? " (oder automatisch)" : "")
                        + " als Zahlen im zulässigen Bereich.";
            }
            case ZEITPUNKT_UNGUELTIG -> satz = "Einstellungen gelten ab einer vollen Minute — Sekunden werden nie "
                    + "gerundet.";
            case VOR_BEGINN -> {
                fakten.put("beginn", zeit(beginn));
                satz = "Die Quelle misst erst ab " + QuelleEinstellungRegeln.zeitpunktText(beginn)
                        + " — eine Einstellung davor gibt es nicht.";
            }
            case NACH_ENDE -> {
                fakten.put("ende", zeit(ende));
                satz = "Die Quelle misst nur bis " + QuelleEinstellungRegeln.zeitpunktText(ende)
                        + " — eine Einstellung danach gibt es nicht.";
            }
            case TATSAECHLICH_UNGUELTIG -> satz = "„tatsaechlich_ab“ liegt vor „gueltig_ab“ und nicht vor dem "
                    + "Beginn der Quelle.";
            case BEGINN_BELEGT -> {
                Fassung b = vorhanden.stream().filter(x -> x.gueltigAb().equals(a.gueltigAb().toInstant()))
                        .findFirst().orElse(null);
                if (b != null) {
                    fakten.put("bestehend", Map.of("id", b.id().toString(),
                            "wert_text", String.valueOf(QuelleEinstellungRegeln.wertText(b.art(), b.wert()))));
                }
                satz = "Ab " + QuelleEinstellungRegeln.zeitpunktText(a.gueltigAb().toInstant())
                        + " gilt schon eine Fassung dieser Art — eine zweite zum selben Zeitpunkt gibt es nicht.";
            }
            case UNVERAENDERT -> satz = "Ab " + QuelleEinstellungRegeln.zeitpunktText(a.gueltigAb().toInstant())
                    + " gilt schon genau diese Einstellung — es gäbe nichts zu ändern.";
            default -> satz = f.code();
        }
        return EinstellungAbgelehnt.regel(f, satz, fakten);
    }

    /**
     * Das Protokoll an jeder gespeisten Messstelle (§4.4): je Messstelle, deren Quellenbindung
     * (führend oder Vergleich) zum Beginn der Fassung aus dieser Quelle liest, ein Eintrag
     * {@code einstellung_geaendert} — „gilt ab", rückwirkend, Begründung und Urheber wie die Fassung,
     * {@code alt}/{@code neu} die Einstellung vorher und nachher. Gibt die Kennzeichen zurück.
     */
    private List<String> anMessstellenProtokollieren(Einbau einbau, Fassung neu, Fassung vorher,
            ProtokollAkteur akteur, Instant jetzt) {
        List<String> kennzeichen = new ArrayList<>();
        for (QuelleEinstellungRepository.Gespeist m : fassungen.gespeisteMessstellen(einbau.id(), neu.entityId(),
                neu.kanal(), neu.gueltigAb())) {
            protokoll.eintragen(new NeuerEintrag(TenantContext.get(), m.id(), PROTOKOLL_ART,
                    vorher == null ? null : protokollWert(einbau, vorher).toString(),
                    protokollWert(einbau, neu).toString(), neu.gueltigAb(), neu.rueckwirkend(), neu.begruendung(),
                    akteur.sub(), akteur.name(), akteur.rolle(), akteur.art()), jetzt);
            kennzeichen.add(m.kennzeichen());
        }
        return kennzeichen;
    }

    /** Eine Fassung, wie das Protokoll der Messstelle sie festhält: die Quelle, die Art, der Wert. */
    private ObjectNode protokollWert(Einbau einbau, Fassung f) {
        ObjectNode n = json.createObjectNode();
        n.put("einstellung", f.id().toString());
        n.put("geraet", einbau.kennzeichen());
        n.put("einbau", einbau.einbauKennzeichen());
        n.put("komponente", f.entityId() == null ? null : f.entityId().toString());
        n.put("kanal", f.kanal());
        n.put("art", f.art());
        n.set("wert", f.wert());
        n.put("wert_text", QuelleEinstellungRegeln.wertText(f.art(), f.wert()));
        n.put("anwendung", f.anwendung());
        n.put("herkunft", f.herkunft());
        return n;
    }

    /** Die Fassung, die die neue beendet hat — so, wie sie vorher gespeichert war. */
    private static Fassung vorgaengerVon(Urteil u, List<Fassung> vorhanden) {
        if (u.vorgaenger() == null) {
            return null;
        }
        UUID id = UUID.fromString(u.vorgaenger().id());
        return vorhanden.stream().filter(f -> f.id().equals(id)).findFirst().orElse(null);
    }

    private static List<Bestehende> bestehende(List<Fassung> vorhanden) {
        return vorhanden.stream().map(f -> new Bestehende(f.id().toString(), f.wert(), f.anwendung(),
                f.gueltigAb(), f.gueltigBis())).toList();
    }

    private static String begruendung(String b) {
        return b == null || b.isBlank() ? null : b.strip();
    }

    /**
     * Der Urheber: der angemeldete Aufrufer ({@link ProtokollAkteur#aus}); ohne Anmeldung (OIDC
     * aus) das Subject, das der PUT mitbringt; ohne beides VoltPilot selbst.
     */
    private static ProtokollAkteur akteur(String subject) {
        Optional<ProtokollAkteur> angemeldet = ProtokollAkteur.aus(SecurityContextHolder.getContext()
                .getAuthentication());
        if (angemeldet.isPresent()) {
            return angemeldet.get();
        }
        if (subject != null && !subject.isBlank()) {
            return ProtokollAkteur.fuer(subject, null, false);
        }
        return new ProtokollAkteur(null, "VoltPilot", null, ProtokollAkteur.ART_VOLTPILOT);
    }

    private JsonNode lies(String verbindung) {
        if (verbindung == null || verbindung.isBlank()) {
            return null;
        }
        try {
            return json.readTree(verbindung);
        } catch (Exception e) {
            return null;
        }
    }

    private static EinstellungDto.Fassung dto(Fassung f, Instant jetzt) {
        Art art = Art.von(f.art());
        return new EinstellungDto.Fassung(f.id(), f.entityId(), f.kanal(), f.art(),
                art == null ? null : art.kundenwort(), f.wert(), QuelleEinstellungRegeln.wertText(f.art(), f.wert()),
                f.anwendung(), QuelleEinstellungRegeln.anwendungText(f.anwendung(), f.herkunft()),
                QuelleEinstellungRegeln.zustellung(f.anwendung(), f.herkunft()), f.herkunft(), zeit(f.gueltigAb()),
                zeit(f.gueltigBis()), QuelleEinstellungRegeln.status(f.gueltigAb(), f.gueltigBis(), jetzt),
                zeit(f.tatsaechlichAb()), f.rueckwirkend(), f.begruendung(),
                new EinstellungDto.Eintrag(zeit(f.eingetragenAm()), f.actorName(), f.actorRolle(), f.actorArt()));
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t.truncatedTo(ChronoUnit.SECONDS),
                QuelleEinstellungRegeln.ZEITZONE);
    }
}
