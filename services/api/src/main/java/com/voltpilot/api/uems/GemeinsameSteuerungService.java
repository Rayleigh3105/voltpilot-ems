package com.voltpilot.api.uems;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Befund;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die Gemeinsame Steuerung einer Anlage als Ablauf (UEMS AP-15 IP-5, Konzept §3.9, §4.9 I1–I6, §5.2–§5.5): lesen mit
 * „was fehlt zum nächsten Schritt“, einrichten/ändern, anhalten, fortsetzen, auflösen — und die zwei Handgriffe des
 * Betreibers, scharfschalten und Mitglied bestätigen (I4/I5, W9; die Routen dafür liegen unter {@code /api/v1/admin}).
 *
 * <p>Die Stufen: Einrichten und jede Änderung der Struktur setzen S0 {@code erklaert}, bei vollständiger Struktur S1
 * {@code beobachtet} (I3); S2 {@code geprueft} setzt IP-21 (Sprungprobe). Scharfschalten prüft ALLE Bedingungen aus I1
 * ({@link SteuerungsverbundScharfschalten}) und setzt eine neue Epoche und S3 {@code anteile_aktiv}; drei Tatsachen
 * haben ihre Quelle noch nicht ({@link SteuerungsverbundNachweise}) — in diesem Paket wird darum keine Anlage scharf.
 *
 * <p>Der Mandant kommt aus dem {@link TenantContext}, die Anlage aus dem Pfad — nie aus einem Körper. Jeder
 * Schreibvorgang hat genau einen Protokolleintrag in derselben Transaktion. Eine Anlage ohne Gemeinsame Steuerung hat
 * keine Zeile und bekommt keine (I6, R22) — auch nicht durch Lesen.
 */
@Service
public class GemeinsameSteuerungService {

    /** Z1 (W2): führende Box ≠ Box des Speichers an einer Anlage OHNE Gemeinsame Steuerung. */
    public static final String WARNUNG_FUEHRUNG = "fuehrende_box_ist_nicht_speicher_box";
    public static final String ZUSTAND_NICHT_EINGERICHTET = "nicht_eingerichtet";
    public static final String ZUSTAND_AUFGELOEST = "aufgeloest";

    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final SteuerungsverbundRepository repo;
    private final AnlageGrenzen grenzen;
    private final SteuerungsverbundNachweise nachweise;
    private final SteuerungsverbundAnteilDienst anteile;
    private final LeadDeviceService fuehrung;
    private final EntityRegistryRepository registry;
    private Clock uhr = Clock.systemUTC();

    public GemeinsameSteuerungService(SteuerungsverbundRepository repo, AnlageGrenzen grenzen,
            SteuerungsverbundNachweise nachweise, LeadDeviceService fuehrung, EntityRegistryRepository registry,
            SteuerungsverbundAnteilDienst anteile) {
        this.anteile = anteile;
        this.repo = repo;
        this.grenzen = grenzen;
        this.nachweise = nachweise;
        this.fuehrung = fuehrung;
        this.registry = registry;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    // ------------------------------------------------------------------ lesen

    /** Der Zustand der Anlage; ohne Gemeinsame Steuerung „nicht eingerichtet“ und sonst nichts (I6). */
    @Transactional(readOnly = true)
    public GemeinsameSteuerungDto.Zustand lesen(UUID siteId) {
        sichtbar(siteId);
        Instant jetzt = uhr.instant();
        Optional<VerbundZeile> v = repo.derAnlage(siteId);
        if (v.isEmpty()) {
            return new GemeinsameSteuerungDto.Zustand(false, ZUSTAND_NICHT_EINGERICHTET, null, null, null, List.of(),
                    null, List.of(), warnungFuehrung(siteId));
        }
        return zustand(siteId, v.get(), jetzt);
    }

    private GemeinsameSteuerungDto.Zustand zustand(UUID siteId, VerbundZeile v, Instant jetzt) {
        List<MitgliedZeile> mitglieder = repo.mitglieder(v.id(), jetzt);
        Map<UUID, Instant> bestaetigt = repo.bestaetigt(v.id());
        List<GemeinsameSteuerungDto.Mitglied> dto = mitglieder.stream().map(m -> new GemeinsameSteuerungDto.Mitglied(
                m.deviceId(), m.rolle().code(), m.dataSourceId(), m.gueltigAb().atOffset(ZoneOffset.UTC),
                Optional.ofNullable(bestaetigt.get(m.id())).map(t -> t.atOffset(ZoneOffset.UTC)).orElse(null)))
                .toList();
        LocalDate tag = tag(jetzt);
        UUID netzanschluss = repo.netzanschluesse(siteId, tag).stream().findFirst().orElse(null);
        if (mitglieder.isEmpty()) {
            return new GemeinsameSteuerungDto.Zustand(true, ZUSTAND_AUFGELOEST, null, v.epoche(), netzanschluss, dto,
                    null, List.of(), null);
        }
        String naechster = switch (v.stufe()) {
            case ERKLAERT -> Stufe.BEOBACHTET.code();
            case BEOBACHTET, GEPRUEFT -> Stufe.ANTEILE_AKTIV.code();
            case ANGEHALTEN -> vomBetreiberAngehalten(v) ? GemeinsameSteuerungAbgelehnt.VOM_BETREIBER_ANGEHALTEN
                    : Stufe.ANTEILE_AKTIV.code();
            case ANTEILE_AKTIV -> null;
        };
        List<Befund> befunde = naechster == null ? List.of()
                : v.stufe() == Stufe.ERKLAERT ? SteuerungsverbundScharfschalten.struktur(urteil(siteId, v, jetzt))
                : urteil(siteId, v, jetzt).befunde();
        return new GemeinsameSteuerungDto.Zustand(true, v.stufe().code(), v.stufe().stufe(), v.epoche(),
                netzanschluss, dto, naechster, befunde(befunde), null);
    }

    /** Z1: nur OHNE Gemeinsame Steuerung, nur mit Speicher, nur wenn die führende Box eine andere ist. */
    private GemeinsameSteuerungDto.WarnungFuehrung warnungFuehrung(UUID siteId) {
        EntityRegistryRepository.BatteryAsset speicher = registry.batteryAsset(siteId);
        if (speicher == null || speicher.deviceId() == null) {
            return null;
        }
        LeadDeviceService.FuehrendeBox f = fuehrung.fuehrendeBox(siteId);
        if (!f.bestimmt() || f.box().equals(speicher.deviceId())) {
            return null;
        }
        return new GemeinsameSteuerungDto.WarnungFuehrung(WARNUNG_FUEHRUNG, f.box(), speicher.deviceId());
    }

    // ------------------------------------------------------------------ einrichten / ändern

    /**
     * Richtet ein oder ändert: {@code mitglieder} ist der gewünschte Stand. Unveränderte Mitglieder bleiben stehen;
     * wer fehlt oder sich ändert, endet mit der laufenden Minute, wer neu ist, beginnt mit ihr. Danach S0 oder S1 (I3).
     */
    @Transactional
    public GemeinsameSteuerungDto.Zustand einrichten(UUID siteId, List<GemeinsameSteuerungDto.MitgliedWunsch> wunsch,
            ProtokollAkteur wer) {
        sichtbar(siteId);
        List<Wunsch> soll = pruefeWunsch(siteId, wunsch);
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        Instant ab = jetzt.truncatedTo(ChronoUnit.MINUTES);
        Optional<VerbundZeile> vorhanden = repo.derAnlage(siteId);
        UUID verbundId;
        if (vorhanden.isEmpty()) {
            verbundId = repo.einrichten(tenant, siteId, wer.name());
            repo.protokoll(tenant, verbundId, siteId, "eingerichtet", null, null, jetzt, false, null, wer);
        } else {
            verbundId = vorhanden.get().id();
            repo.sperren(verbundId);
            Stufe stufe = repo.finden(verbundId).orElseThrow().stufe();
            if (stufe == Stufe.ANTEILE_AKTIV) {
                throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.ERST_ANHALTEN,
                        "Die Anteile sind aktiv. Bitte die Gemeinsame Steuerung zuerst anhalten.");
            }
        }
        boolean geaendert = vorhanden.isEmpty();
        List<MitgliedZeile> ist = repo.mitglieder(verbundId, jetzt);
        for (MitgliedZeile m : ist) {
            if (!soll.contains(new Wunsch(m.deviceId(), m.rolle(), m.dataSourceId()))) {
                beenden(m, ab);
                repo.protokoll(tenant, verbundId, siteId, "mitglied", json(m.deviceId(), m.rolle(), m.dataSourceId()),
                        null, ab, false, null, wer);
                geaendert = true;
            }
        }
        for (Wunsch w : soll) {
            boolean da = ist.stream().anyMatch(m -> new Wunsch(m.deviceId(), m.rolle(), m.dataSourceId()).equals(w));
            if (!da) {
                repo.mitgliedAufnehmen(tenant, verbundId, w.box(), w.rolle(), w.messpunkt(), ab, null, wer.name());
                repo.protokoll(tenant, verbundId, siteId, "mitglied", null, json(w.box(), w.rolle(), w.messpunkt()),
                        ab, false, null, wer);
                geaendert = true;
            }
        }
        VerbundZeile v = repo.finden(verbundId).orElseThrow();
        if (geaendert) {
            Stufe neu = SteuerungsverbundScharfschalten.stufeNachAenderung(urteil(siteId, v, jetzt));
            stufeWechseln(tenant, v, neu, jetzt, wer);
            v = repo.finden(verbundId).orElseThrow();
        }
        return zustand(siteId, v, jetzt);
    }

    // ------------------------------------------------------------------ Übergänge

    /** Anhalten (Kunde oder Betreiber): nur die führende Box bekommt Pläne; die Anteile bleiben in Kraft. */
    @Transactional
    public GemeinsameSteuerungDto.Zustand anhalten(UUID siteId, ProtokollAkteur wer) {
        VerbundZeile v = gesperrt(siteId);
        if (v.stufe() != Stufe.ANTEILE_AKTIV) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.NICHT_AKTIV,
                    "Die Gemeinsame Steuerung ist nicht aktiv.");
        }
        Instant jetzt = uhr.instant();
        stufeWechseln(TenantContext.get(), v, Stufe.ANGEHALTEN, jetzt, wer);
        return zustand(siteId, repo.finden(v.id()).orElseThrow(), jetzt);
    }

    /**
     * Fortsetzen nach dem Anhalten: ohne neue Probe und in derselben Epoche, weil jede Änderung der Struktur die Stufe
     * zurücksetzt (angehalten heißt: seit dem Scharfschalten unverändert) — aber mit allen Bedingungen aus I1 erneut in
     * derselben Transaktion. Hat der Betreiber angehalten, setzt nur der Betreiber fort (W9/I5): ein Kundenkonto
     * bekommt 409 {@code vom_betreiber_angehalten}; der Betreiber darf auch ein Anhalten des Kunden aufheben. Wer
     * handelt, sagt {@link ProtokollAkteur#art()} — die Plattform ist {@code voltpilot}, über welche Route auch immer.
     */
    @Transactional
    public GemeinsameSteuerungDto.Zustand fortsetzen(UUID siteId, ProtokollAkteur wer) {
        VerbundZeile v = gesperrt(siteId);
        if (v.stufe() != Stufe.ANGEHALTEN) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.NICHT_ANGEHALTEN,
                    "Die Gemeinsame Steuerung ist nicht angehalten.");
        }
        if (!betreiber(wer) && vomBetreiberAngehalten(v)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.VOM_BETREIBER_ANGEHALTEN,
                    "VoltPilot hat die Gemeinsame Steuerung angehalten; fortsetzen kann nur VoltPilot.");
        }
        Instant jetzt = uhr.instant();
        bedingungenPruefen(siteId, v, jetzt);
        stufeWechseln(TenantContext.get(), v, Stufe.ANTEILE_AKTIV, jetzt, wer);
        return zustand(siteId, repo.finden(v.id()).orElseThrow(), jetzt);
    }

    /**
     * Auflösen: alle Mitglieder enden mit der laufenden Minute; die Anlage läuft wie seit AP-06. Nach einem
     * Scharfschalten sind Anteile an den Boxen in Kraft — dann nur über die Änderung im Zweischritt (IP-7).
     */
    @Transactional
    public GemeinsameSteuerungDto.Zustand aufloesen(UUID siteId, ProtokollAkteur wer) {
        VerbundZeile v = gesperrt(siteId);
        if (v.stufe() == Stufe.ANTEILE_AKTIV) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.ERST_ANHALTEN,
                    "Die Anteile sind aktiv. Bitte die Gemeinsame Steuerung zuerst anhalten.");
        }
        if (v.epoche() > 0) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.ANTEILE_IN_KRAFT,
                    "Die Anteile sind an den Boxen in Kraft und werden nur im Zweischritt zurückgenommen.");
        }
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        Instant ab = jetzt.truncatedTo(ChronoUnit.MINUTES);
        for (MitgliedZeile m : repo.mitglieder(v.id(), jetzt)) {
            beenden(m, ab);
            repo.protokoll(tenant, v.id(), siteId, "mitglied", json(m.deviceId(), m.rolle(), m.dataSourceId()), null,
                    ab, false, null, wer);
        }
        stufeWechseln(tenant, v, Stufe.ERKLAERT, jetzt, wer);
        return zustand(siteId, repo.finden(v.id()).orElseThrow(), jetzt);
    }

    /**
     * Scharfschalten — Handgriff des Betreibers (I4, I5, W9): ALLE Bedingungen aus I1; abgelehnt wird mit dem ersten
     * Wort in Vokabular-Reihenfolge, {@code fehlt} nennt alle. Zulässig: neue Epoche (G5), S3, alle wirksamen
     * Mitglieder gelten als bestätigt.
     */
    @Transactional
    public GemeinsameSteuerungDto.Zustand scharfschalten(UUID siteId, ProtokollAkteur wer) {
        VerbundZeile v = gesperrt(siteId);
        if (v.stufe() == Stufe.ANTEILE_AKTIV) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.BEREITS_AKTIV,
                    "Die Anteile sind schon aktiv.");
        }
        Instant jetzt = uhr.instant();
        bedingungenPruefen(siteId, v, jetzt);
        UUID tenant = TenantContext.get();
        long epoche = repo.epocheErhoehen(v.id()).orElseThrow();
        repo.protokoll(tenant, v.id(), siteId, "epoche", Long.toString(v.epoche()), Long.toString(epoche), jetzt,
                false, null, wer);
        for (MitgliedZeile m : repo.mitglieder(v.id(), jetzt)) {
            if (repo.bestaetigen(m.id(), wer.name(), jetzt)) {
                repo.protokoll(tenant, v.id(), siteId, "mitglied", null, bestaetigtJson(m), jetzt, false, null, wer);
            }
        }
        stufeWechseln(tenant, v, Stufe.ANTEILE_AKTIV, jetzt, wer);
        // IP-7: der Zweischritt in der neuen Epoche — Übergang an alle, der Zielstand nach den Quittungen (G5)
        anteile.anteileAusrollen(siteId, wer);
        return zustand(siteId, repo.finden(v.id()).orElseThrow(), jetzt);
    }

    /** Mitglied bestätigen — Handgriff des Betreibers nach dem Box-Tausch (I4, §5.7, R17). */
    @Transactional
    public GemeinsameSteuerungDto.Zustand bestaetigen(UUID siteId, UUID box, ProtokollAkteur wer) {
        VerbundZeile v = gesperrt(siteId);
        Instant jetzt = uhr.instant();
        MitgliedZeile m = repo.mitglieder(v.id(), jetzt).stream().filter(x -> x.deviceId().equals(box)).findFirst()
                .orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.KEIN_MITGLIED,
                        "Diese Box ist kein Mitglied der Gemeinsamen Steuerung."));
        if (!repo.bestaetigen(m.id(), wer.name(), jetzt)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.BEREITS_BESTAETIGT,
                    "Dieses Mitglied ist schon bestätigt.");
        }
        repo.protokoll(TenantContext.get(), v.id(), siteId, "mitglied", null, bestaetigtJson(m), jetzt, false,
                null, wer);
        return zustand(siteId, repo.finden(v.id()).orElseThrow(), jetzt);
    }

    // ------------------------------------------------------------------ Prüfung

    /** Das Urteil über alle Bedingungen des Scharfschaltens am Zeitpunkt. */
    SteuerungsverbundRegeln.Urteil urteil(UUID siteId, VerbundZeile v, Instant jetzt) {
        LocalDate tag = tag(jetzt);
        SteuerungsverbundRepository.RegelStand stand = repo.regelStand(siteId, jetzt, tag).orElseThrow();
        List<SteuerungsverbundRegeln.Mitglied> mitglieder = stand.verbund().mitglieder();
        List<UUID> boxen = mitglieder.stream().map(m -> UUID.fromString(m.box())).toList();
        Optional<Map<Grenzart, SteuerungsverbundRegeln.Richtung>> auslegung = mitglieder.isEmpty() ? Optional.empty()
                : nachweise.auslegung(siteId, boxen, tag);
        SteuerungsverbundRegeln.Urteil objekt = SteuerungsverbundRegeln.pruefen(stand.verbund(), stand.quellen(),
                auslegung.orElse(null));
        GrenzeAufloesung.Grenzen anlage = repo.grenzenDerAnlage(siteId);
        GrenzeAufloesung.Wirksam w = grenzen.wirksam(siteId, tag, anlage.einspeisungKw(), anlage.bezugKw());
        boolean grenzenGesetzt = w.einspeisungKw() != null && w.bezugKw() != null;
        Map<String, SteuerungsverbundScharfschalten.Box> jeBox = new LinkedHashMap<>();
        for (UUID box : boxen) {
            jeBox.put(box.toString(), new SteuerungsverbundScharfschalten.Box(box.toString(), repo.boxAngemeldet(box),
                    nachweise.faehigkeit(box), nachweise.sprungprobe(v.id(), box), nachweise.verbraucher14a(siteId, box),
                    nachweise.vorgabeSignal(siteId, box)));
        }
        return SteuerungsverbundScharfschalten.pruefen(objekt, mitglieder, grenzenGesetzt, auslegung.isPresent(),
                jeBox);
    }

    private void bedingungenPruefen(UUID siteId, VerbundZeile v, Instant jetzt) {
        SteuerungsverbundRegeln.Urteil u = urteil(siteId, v, jetzt);
        if (!u.zulaessig()) {
            throw GemeinsameSteuerungAbgelehnt.bedingung(u.ablehnung(), befunde(u.befunde()));
        }
    }

    /**
     * Was DB und Regel strukturell ausschließen, wird vor dem Schreiben benannt: eine Box, deren Heimat nicht diese
     * Anlage ist (409 {@code box_nicht_in_anlage}, T1, R20), ein Messpunkt einer anderen Anlage und eine führende Box
     * ohne Messpunkt (409 {@code fuehrende_box_misst_nicht}/{@code mitsteuernde_box_misst_nicht}, B1/B3); eine Box
     * oder ein Messpunkt doppelt, zwei führende oder eine unbekannte Rolle sind 400.
     */
    private List<Wunsch> pruefeWunsch(UUID siteId, List<GemeinsameSteuerungDto.MitgliedWunsch> wunsch) {
        if (wunsch == null || wunsch.isEmpty()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Bitte mindestens eine Box nennen.");
        }
        List<Wunsch> soll = new ArrayList<>();
        Set<UUID> boxen = new HashSet<>();
        Set<UUID> messpunkte = new HashSet<>();
        int fuehrende = 0;
        for (GemeinsameSteuerungDto.MitgliedWunsch w : wunsch) {
            if (w == null || w.boxId() == null || w.rolle() == null) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Jedes Mitglied braucht box_id und rolle.");
            }
            Rolle rolle = rolle(w.rolle());
            if (!boxen.add(w.boxId())) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Eine Box steht doppelt.");
            }
            if (w.messpunktId() != null && !messpunkte.add(w.messpunktId())) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Ein Messpunkt steht doppelt (kein Doppel-Lesen).");
            }
            if (rolle == Rolle.FUEHRT && ++fuehrende > 1) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Genau eine Box führt.");
            }
            soll.add(new Wunsch(w.boxId(), rolle, w.messpunktId()));
        }
        List<GemeinsameSteuerungDto.Befund> befunde = new ArrayList<>();
        for (Wunsch w : soll) {
            boolean daheim = repo.heimatDerBox(w.box()).filter(siteId::equals).isPresent() && repo.boxAngemeldet(w.box());
            if (!daheim) {
                befunde.add(new GemeinsameSteuerungDto.Befund(Ablehnung.BOX_NICHT_IN_ANLAGE.code(), w.box(), null));
            }
        }
        for (Wunsch w : soll) {
            boolean ohne = w.messpunkt() == null
                    || repo.anlageDerQuelle(w.messpunkt()).filter(siteId::equals).isEmpty();
            if (ohne && w.rolle() == Rolle.FUEHRT) {
                befunde.add(new GemeinsameSteuerungDto.Befund(Ablehnung.FUEHRENDE_BOX_MISST_NICHT.code(), w.box(),
                        null));
            }
        }
        for (Wunsch w : soll) {
            if (w.rolle() == Rolle.STEUERT_MIT && w.messpunkt() != null
                    && repo.anlageDerQuelle(w.messpunkt()).filter(siteId::equals).isEmpty()) {
                befunde.add(new GemeinsameSteuerungDto.Befund(Ablehnung.MITSTEUERNDE_BOX_MISST_NICHT.code(), w.box(),
                        null));
            }
        }
        if (!befunde.isEmpty()) {
            throw GemeinsameSteuerungAbgelehnt.bedingung(Ablehnung.valueOf(befunde.get(0).wort().toUpperCase()),
                    befunde);
        }
        return soll;
    }

    // ------------------------------------------------------------------ Gerüst

    private record Wunsch(UUID box, Rolle rolle, UUID messpunkt) {}

    private void sichtbar(UUID siteId) {
        if (!repo.anlageSichtbar(siteId)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
    }

    /** Der Verbund der Anlage, für diese Transaktion gesperrt — 404 ohne Anlage, 409 ohne Gemeinsame Steuerung. */
    private VerbundZeile gesperrt(UUID siteId) {
        sichtbar(siteId);
        VerbundZeile v = repo.derAnlage(siteId).orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(
                GemeinsameSteuerungAbgelehnt.NICHT_EINGERICHTET, "Die Anlage hat keine Gemeinsame Steuerung."));
        repo.sperren(v.id());
        return repo.finden(v.id()).orElseThrow();
    }

    /** Die Plattform (Betreiber) handelt — am Umschalter über eine Kundenroute oder über {@code /api/v1/admin}. */
    private static boolean betreiber(ProtokollAkteur wer) {
        return ProtokollAkteur.ART_VOLTPILOT.equals(wer.art());
    }

    /**
     * Das jüngste Anhalten kam NICHT von einem Kundenkonto (Akteur-Art im Protokoll). Ohne Eintrag gilt es als
     * Betreiber-Anhalten — die sichere Seite.
     */
    private boolean vomBetreiberAngehalten(VerbundZeile v) {
        return v.stufe() == Stufe.ANGEHALTEN
                && !repo.letztesAnhalten(v.id()).map(ProtokollAkteur.ART_KUNDE::equals).orElse(false);
    }

    private void stufeWechseln(UUID tenant, VerbundZeile v, Stufe neu, Instant jetzt, ProtokollAkteur wer) {
        if (v.stufe() == neu) {
            return;
        }
        repo.stufeSetzen(v.id(), neu);
        repo.protokoll(tenant, v.id(), v.siteId(), "stufe", quote(v.stufe().code()), quote(neu.code()), jetzt, false,
                null, wer);
    }

    /** Beendet mit der laufenden Minute; wer in ihr erst begann, wird aufgehoben (ein leerer Zeitraum gibt es nicht). */
    private void beenden(MitgliedZeile m, Instant ab) {
        if (m.gueltigAb().isBefore(ab)) {
            repo.mitgliedBeenden(m.id(), ab);
        } else {
            repo.mitgliedAufheben(m.id());
        }
    }

    private static Rolle rolle(String code) {
        if (Rolle.FUEHRT.code().equals(code)) {
            return Rolle.FUEHRT;
        }
        if (Rolle.STEUERT_MIT.code().equals(code)) {
            return Rolle.STEUERT_MIT;
        }
        throw GemeinsameSteuerungAbgelehnt.anfrage("Die Rolle ist „fuehrt“ oder „steuert_mit“ — Lesen macht kein "
                + "Mitglied (T6).");
    }

    static LocalDate tag(Instant jetzt) {
        return jetzt.atZone(ZONE).toLocalDate();
    }

    private static List<GemeinsameSteuerungDto.Befund> befunde(List<Befund> befunde) {
        return befunde.stream().map(b -> new GemeinsameSteuerungDto.Befund(b.ablehnung().code(),
                b.box() == null ? null : UUID.fromString(b.box()), SteuerungsverbundScharfschalten.richtung(b)))
                .toList();
    }

    private static String json(UUID box, Rolle rolle, UUID messpunkt) {
        return "{\"box_id\":" + quote(box.toString()) + ",\"rolle\":" + quote(rolle.code()) + ",\"messpunkt_id\":"
                + (messpunkt == null ? "null" : quote(messpunkt.toString())) + "}";
    }

    private static String bestaetigtJson(MitgliedZeile m) {
        return "{\"box_id\":" + quote(m.deviceId().toString()) + ",\"bestaetigt\":true}";
    }

    private static String quote(String s) {
        return "\"" + Objects.requireNonNull(s) + "\"";
    }
}
