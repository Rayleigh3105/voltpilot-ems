package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Ergebnis;
import com.voltpilot.api.uems.SteuerungsverbundAnteilDienst.Grund;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.DokumentZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.Ausscheiden;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Ausscheiden eines Mitglieds aus der Gemeinsamen Steuerung (Konzept §5.5 „Auflösen: eine Box verlässt die Anlage“, I3,
 * I4, G5, V5, R12). Zwei Wege führen hierher:
 *
 * <ul>
 *   <li><b>Route</b> {@code POST …/mitglieder/{boxId}/ausscheiden} (Kunde): die Box lebt und quittiert — das Mitglied
 *       wartet auf ihre Quittung ({@code quittung}).</li>
 *   <li><b>Abmelden</b> der Box ({@code DELETE /api/v1/devices/{id}}, {@link #beimAusbau}): sie antwortet nicht mehr —
 *       das Mitglied wartet auf die Bestätigung des Betreibers, dass ihre Geräte vom Netz sind ({@code betreiber}).</li>
 * </ul>
 *
 * <p>Beide sind derselbe Zweischritt ({@link SteuerungsverbundAnteilDienst#ausscheidenBeginnen}): Übergang = die Box auf
 * den Rückfall ihrer Geräte, die anderen bleiben; Ziel erst nach ihrer Quittung oder nach {@link #vomNetz} (Plattform).
 * Die führende Box scheidet nicht aus, solange eine andere Box mitsteuert ({@code fuehrende_box_bleibt}). Ohne Anteile in
 * Kraft (nie scharf) endet die Mitgliedschaft sofort. Ohne Gemeinsame Steuerung an der Anlage: eine Abfrage, kein
 * Schreiben (I6).
 */
@Service
public class GemeinsameSteuerungAusscheiden {

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository anteile;
    private final SteuerungsverbundAnteilDienst dienst;
    private Clock uhr = Clock.systemUTC();

    public GemeinsameSteuerungAusscheiden(SteuerungsverbundRepository verbuende,
            SteuerungsverbundAnteilRepository anteile, SteuerungsverbundAnteilDienst dienst) {
        this.verbuende = verbuende;
        this.anteile = anteile;
        this.dienst = dienst;
    }

    void uhr(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Das Mitglied {@code box} beginnt auszuscheiden; der Verbund ist in dieser Transaktion gesperrt. 409 in der
     * Reihenfolge {@code kein_mitglied} · {@code fuehrende_box_bleibt} · {@code scheidet_schon_aus} ·
     * {@code zweischritt_laeuft} · {@code rueckgespielt} · {@code ausscheiden_passt_nicht} (nur auf der Route; beim
     * Abmelden bleibt das Mitglied markiert und wartet auf den Betreiber).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void starten(VerbundZeile v, UUID box, String wartetAuf, ProtokollAkteur wer) {
        Instant jetzt = uhr.instant();
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(v.id(), jetzt);
        MitgliedZeile m = mitglied(mitglieder, box);
        if (m.rolle() == Rolle.FUEHRT) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.FUEHRENDE_BOX_BLEIBT,
                    mitglieder.size() > 1
                            ? "Die führende Box bleibt, solange eine andere Box mitsteuert. Bitte zuerst die Rolle wechseln."
                            : "Die führende Box verlässt die Gemeinsame Steuerung nur mit dem Auflösen.");
        }
        UUID tenant = TenantContext.get();
        Map<UUID, Ausscheiden> schon = verbuende.ausscheidende(v.id(), jetzt);
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        if (dokumente.isEmpty() || v.epoche() == 0) {
            // Keine Anteile in Kraft: die Mitgliedschaft endet mit der laufenden Minute (wie das Auflösen vor S3).
            Instant ab = jetzt.truncatedTo(ChronoUnit.MINUTES);
            if (m.gueltigAb().isBefore(ab)) {
                verbuende.mitgliedBeenden(m.id(), ab);
            } else {
                verbuende.mitgliedAufheben(m.id());
            }
            verbuende.protokoll(tenant, v.id(), v.siteId(), SteuerungsverbundAnteilDienst.ART_AUSGESCHIEDEN,
                    mitgliedJson(m), null, ab, false, "ohne_anteile", wer);
            return;
        }
        Ausscheiden laufend = schon.get(box);
        if (laufend != null) {
            if (SteuerungsverbundAnteilDienst.WARTET_AUF_BETREIBER.equals(wartetAuf)
                    && SteuerungsverbundAnteilDienst.WARTET_AUF_QUITTUNG.equals(laufend.wartetAuf())) {
                // Die Box wird abgemeldet, während sie schon ausscheidet: sie quittiert nicht mehr (§5.5).
                verbuende.ausscheidenSetzen(m.id(), wartetAuf, wer.name(), jetzt);
                verbuende.protokoll(tenant, v.id(), v.siteId(), SteuerungsverbundAnteilDienst.ART_AUSGESCHIEDEN,
                        wartetJson(box, laufend.wartetAuf()), wartetJson(box, wartetAuf), jetzt, false,
                        "box_abgemeldet", wer);
                return;
            }
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.SCHEIDET_SCHON_AUS,
                    "Diese Box scheidet schon aus.");
        }
        if (!schon.isEmpty() || dokumente.get(0).ziel() != null) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.ZWEISCHRITT_LAEUFT,
                    "Eine Änderung der Anteile wird gerade übernommen. Bitte warten, bis alle Boxen bestätigt haben.");
        }
        verbuende.ausscheidenSetzen(m.id(), wartetAuf, wer.name(), jetzt);
        verbuende.protokoll(tenant, v.id(), v.siteId(), SteuerungsverbundAnteilDienst.ART_AUSGESCHIEDEN,
                mitgliedJson(m), wartetJson(box, wartetAuf), jetzt, false, "ausscheiden_begonnen", wer);
        Ergebnis e = dienst.ausscheidenBeginnen(v, wer);
        boolean route = SteuerungsverbundAnteilDienst.WARTET_AUF_QUITTUNG.equals(wartetAuf);
        if (e.grund() == Grund.RUECKGESPIELT && route) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.RUECKGESPIELT,
                    "Die Anteile werden erst nach dem nächsten Scharfschalten wieder geändert.");
        }
        if (e.grund() == Grund.AUSLEGUNG_PASST_NICHT && route) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.AUSSCHEIDEN_PASST_NICHT,
                    "Ohne diese Box passt die Auslegung nicht. VoltPilot prüft die Anlage.");
        }
    }

    /**
     * Der Betreiber bestätigt: die Geräte der ausscheidenden Box sind vom Netz (I4). Ihr Rückfall bleibt nicht
     * reserviert; hat noch kein Übergang die Box erfasst (Auslegung passte ohne die Bestätigung nicht), geht er jetzt.
     * Das Ziel folgt ohne ihre Quittung, sobald keine andere verengte Box mehr aussteht. 409 {@code kein_mitglied} ·
     * {@code scheidet_nicht_aus} · {@code bereits_bestaetigt}.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void vomNetz(VerbundZeile v, UUID box, ProtokollAkteur wer) {
        Instant jetzt = uhr.instant();
        MitgliedZeile m = mitglied(verbuende.mitglieder(v.id(), jetzt), box);
        Ausscheiden a = verbuende.ausscheidende(v.id(), jetzt).get(box);
        if (a == null) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.SCHEIDET_NICHT_AUS,
                    "Diese Box scheidet nicht aus.");
        }
        if (!verbuende.vomNetzBestaetigen(m.id(), wer.name(), jetzt)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.BEREITS_BESTAETIGT,
                    "Dass die Geräte vom Netz sind, ist schon bestätigt.");
        }
        verbuende.protokoll(TenantContext.get(), v.id(), v.siteId(), SteuerungsverbundAnteilDienst.ART_AUSGESCHIEDEN,
                wartetJson(box, a.wartetAuf()), "{\"box_id\":\"" + box + "\",\"geraete_vom_netz\":true}", jetzt, false,
                "geraete_vom_netz", wer);
        List<DokumentZeile> dokumente = anteile.dokumente(v.id());
        boolean erfasst = !dokumente.isEmpty()
                && dokumente.get(0).tabelle().boxen().contains(box.toString())
                && SteuerungsverbundAnteilDienst.ANLASS_AUSSCHEIDEN.equals(dokumente.get(0).anlass());
        if (!erfasst) {
            dienst.ausscheidenBeginnen(v, wer);
        }
        dienst.ausscheidenPruefen(v);
    }

    /**
     * Die Box wird abgemeldet (ausgebaut, {@code DeviceController#unclaim}): ist sie Mitglied einer Gemeinsamen Steuerung,
     * scheidet sie aus und wartet auf den Betreiber. Die führende Box einer Anlage, in der eine andere mitsteuert, ist
     * 409 {@code fuehrende_box_bleibt} — dann wird nicht abgemeldet. Ohne Gemeinsame Steuerung: nichts (I6).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void beimAusbau(UUID box, ProtokollAkteur wer) {
        Optional<UUID> anlage = verbuende.heimatDerBox(box);
        Optional<VerbundZeile> gefunden = anlage.flatMap(verbuende::derAnlage);
        if (gefunden.isEmpty()) {
            return;
        }
        verbuende.sperren(gefunden.get().id());
        VerbundZeile v = verbuende.finden(gefunden.get().id()).orElseThrow();
        if (verbuende.mitglieder(v.id(), uhr.instant()).stream().noneMatch(m -> m.deviceId().equals(box))) {
            return;
        }
        try {
            starten(v, box, SteuerungsverbundAnteilDienst.WARTET_AUF_BETREIBER,
                    wer != null ? wer : new ProtokollAkteur(null, "Abmeldung der Box", "voltpilot_betrieb",
                            ProtokollAkteur.ART_VOLTPILOT));
        } catch (GemeinsameSteuerungAbgelehnt e) {
            throw new BoxKonflikt(e.code(), e.getMessage());
        }
    }

    private static MitgliedZeile mitglied(List<MitgliedZeile> mitglieder, UUID box) {
        return mitglieder.stream().filter(x -> x.deviceId().equals(box)).findFirst()
                .orElseThrow(() -> GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.KEIN_MITGLIED,
                        "Diese Box ist kein Mitglied der Gemeinsamen Steuerung."));
    }

    private static String mitgliedJson(MitgliedZeile m) {
        return "{\"box_id\":\"" + m.deviceId() + "\",\"rolle\":\"" + m.rolle().code() + "\"}";
    }

    private static String wartetJson(UUID box, String wartetAuf) {
        return "{\"box_id\":\"" + box + "\",\"scheidet_aus\":true,\"wartet_auf\":\"" + wartetAuf + "\"}";
    }
}
