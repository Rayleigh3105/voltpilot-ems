package com.voltpilot.api.zugriff;

import com.voltpilot.api.uems.KorrekturRechte;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Code;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.SichtErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.StandortSicht;
import com.voltpilot.api.uems.RechteAbleitung.TeilansichtErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.UnterstuetzungErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.web.dto.SelbstauskunftDto;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import com.voltpilot.api.zugriff.ZugriffRepository.MitName;
import com.voltpilot.api.zugriff.ZugriffRepository.StandortEintrag;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Baut die Selbstauskunft {@code GET /api/v1/me} (UEMS AP-03 IP-4) aus dem {@link ZugriffContext} der Anfrage — mit
 * den Ableitungen des Rechte-Vertrags ({@link RechteAbleitung#sichtbareStandorte}, {@link RechteAbleitung#darf} je
 * Aktion der ganzen Matrix, {@link RechteAbleitung#ocppStufe}, {@link RechteAbleitung#unterstuetzung}), nie mit einer
 * eigenen Regel.
 *
 * <p>Der Aufrufer als {@link Benutzer} des Vertrags:
 * <ul>
 *   <li>Kundenkonto: JEDE seiner Zuweisungen im Kundenbereich (wirksame, künftige, beendete — für „wirkt ab").</li>
 *   <li>Partner/Plattform über {@code X-Kundenbereich}: nur die Unterstützungen, die ihn hineinlassen.</li>
 *   <li>Plattform am Umschalter ({@code X-Tenant-Id}, bis IP-8): wie heute {@link KorrekturRechte#benutzer} —
 *       VoltPilot-Unterstützung mandantenweit.</li>
 * </ul>
 * Name und Zustand stehen im Spiegel ({@code benutzer}); fehlt er, gilt der Name aus dem Token und „aktiv" (das
 * Token beweist die Anmeldung). Gewährte Unterstützungen sieht ein Kundenkonto nur an seinen sichtbaren Standorten;
 * ohne angenommenen Kundenbereich gibt es nur das eigene Konto.
 */
@Service
public class Selbstauskunft {

    private static final Kundenbereich OHNE_KUNDENBEREICH = new Kundenbereich("", List.of(), List.of());

    private final ZugriffRepository zugriffe;
    private final ZugriffKontextLader lader;
    private final Geltungsbereich geltungsbereich;

    public Selbstauskunft(ZugriffRepository zugriffe, ZugriffKontextLader lader, Geltungsbereich geltungsbereich) {
        this.zugriffe = zugriffe;
        this.lader = lader;
        this.geltungsbereich = geltungsbereich;
    }

    @Transactional
    public SelbstauskunftDto fuer(Authentication auth) {
        // Die Selbstauskunft rechnet die Sichtbarkeit selbst nach dem Rechte-Vertrag (n von m Standorten, Zuweisungen
        // an fremden Standorten) und gibt nichts Unsichtbares aus — sie liest darum ohne Standort-Zaun (IP-5).
        geltungsbereich.ganzenKundenbereichLesen();
        Zugriff z = ZugriffContext.get();
        Jwt jwt = auth != null && auth.getPrincipal() instanceof Jwt j ? j : null;
        String sub = jwt == null ? null : jwt.getSubject();
        String tokenName = jwt == null ? null : tokenName(jwt);
        Konto konto = auth == null ? null : ZugriffKontextLader.konto(auth);
        Instant jetzt = z != null ? z.stand() : lader.jetzt();
        if (z == null) {
            Benutzer b = new Benutzer(sub, tokenName, konto, KontoZustand.AKTIV, List.of());
            return new SelbstauskunftDto(sub, tokenName, code(konto), KontoZustand.AKTIV.code(), null, null, List.of(),
                    false, List.of(), rechte(b, OHNE_KUNDENBEREICH, Ziel.unternehmen(), jetzt), List.of(), null, null,
                    SelbstauskunftDto.Unterstuetzungen.KEINE, List.of(), List.of());
        }

        if (jwt != null && sub != null && sub.equals(z.sub()) && z.zugang() != Zugang.UMSCHALTER) {
            ProtokollAkteur.aus(auth).ifPresent(akteur -> zugriffe.ersteAnmeldung(sub, jetzt, akteur));
        }

        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        ZoneId zone = kopf.zeitzone();
        List<StandortEintrag> standorte = zugriffe.standorte();
        Map<String, UUID> ids = new HashMap<>();
        standorte.forEach(s -> ids.put(s.kurzzeichen(), s.id()));
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt).stream()
                .map(a -> new Person(a.zeile().benutzerSub(), a.name())).distinct().toList();
        Kundenbereich k = new Kundenbereich(kopf.name(),
                standorte.stream().map(s -> new RechteAbleitung.Standort(s.kurzzeichen(), s.name())).toList(),
                kundenadministratoren);

        Benutzer b = benutzer(z, sub, tokenName, konto);
        SichtErgebnis sicht = RechteAbleitung.sichtbareStandorte(b, k, jetzt, zone);
        Set<String> sichtbar = sicht.standorte().stream().map(StandortSicht::kennzeichen).collect(Collectors.toSet());

        List<SelbstauskunftDto.Standort> sichtbareStandorte = sicht.standorte().stream()
                .map(s -> new SelbstauskunftDto.Standort(ids.get(s.kennzeichen()), s.kennzeichen(), s.name(),
                        s.rollen().stream().map(Rolle::code).toList(), code(s.umfang()),
                        RechteAbleitung.ocppStufe(b, k, s.kennzeichen(), jetzt).stufe().code(),
                        rechte(b, k, Ziel.standort(s.kennzeichen()), jetzt)))
                .toList();
        List<String> rollen = Arrays.stream(Rolle.values())
                .filter(r -> b.zuweisungen().stream().anyMatch(x -> x.rolle() == r && x.wirksam(jetzt)))
                .map(Rolle::code).toList();
        List<SelbstauskunftDto.Unterstuetzung> eigene = z.zugang() == Zugang.UNTERSTUETZUNG
                ? unterstuetzungen(z.zuweisungen().stream().map(x -> new MitName(x, b.name())).toList(), k, sichtbar,
                        jetzt, zone, true)
                : List.of();
        List<SelbstauskunftDto.Unterstuetzung> gewaehrte = z.zugang() == Zugang.KONTO
                ? unterstuetzungen(zugriffe.wirksamImKundenbereich(Rolle.UNTERSTUETZER, jetzt), k, sichtbar, jetzt, zone,
                        false)
                : List.of();

        return new SelbstauskunftDto(
                sub,
                b.name(),
                code(b.konto()),
                b.zustand().code(),
                new SelbstauskunftDto.Kundenbereich(z.kundenbereich(), k.name()),
                z.zugang().code(),
                rollen,
                sicht.unternehmensweit(),
                sichtbareStandorte,
                rechte(b, k, Ziel.unternehmen(), jetzt),
                sicht.kuenftig().stream()
                        .map(x -> new SelbstauskunftDto.Kuenftig(x.standort(), zeit(x.ab(), zone), x.text())).toList(),
                sicht.text(),
                teilansicht(sicht.teilansicht()),
                new SelbstauskunftDto.Unterstuetzungen(eigene, gewaehrte),
                kundenadministratoren.stream().map(p -> new SelbstauskunftDto.Person(p.kennung(), p.name())).toList(), List.of());
    }

    private Benutzer benutzer(Zugriff z, String sub, String tokenName, Konto konto) {
        if (z.zugang() == Zugang.UMSCHALTER) {
            return KorrekturRechte.benutzer(ProtokollAkteur.fuer(sub, tokenName, true));
        }
        Optional<BenutzerSpiegel> spiegel = zugriffe.spiegel(sub);
        String name = spiegel.map(BenutzerSpiegel::anzeigename).orElse(tokenName);
        KontoZustand zustand = spiegel.map(BenutzerSpiegel::zustand).orElse(KontoZustand.AKTIV);
        List<Zeile> zeilen = zugriffe.zuweisungen(sub);
        if (z.zugang() == Zugang.UNTERSTUETZUNG) {
            zeilen = zeilen.stream().filter(x -> ZugriffKontextLader.gilt(konto, x)).toList();
        }
        return new Benutzer(sub, name, konto, zustand, zeilen.stream().map(Zeile::alsZuweisung).toList());
    }

    /** Die Aktionen der Matrix (in ihrer Folge), die der Aufrufer an diesem Ziel darf. */
    private static List<String> rechte(Benutzer b, Kundenbereich k, Ziel ziel, Instant jetzt) {
        RechteAbleitung.Matrix m = RechteMatrixDatei.matrix();
        return RechteMatrixDatei.aktionen().stream()
                .filter(a -> RechteAbleitung.darf(m, b, k, a, ziel, jetzt).darf())
                .toList();
    }

    /**
     * Die wirksamen Unterstützungen an den sichtbaren Standorten — die Zeilen einer Gewährung (eine je Standort)
     * wieder zusammengefasst — mit Zustand, Ende, Erinnerung und dem Banner-Satz aus dem Vertrag.
     */
    private List<SelbstauskunftDto.Unterstuetzung> unterstuetzungen(List<MitName> zeilen, Kundenbereich k,
            Set<String> sichtbar, Instant jetzt, ZoneId zone, boolean eigene) {
        Map<List<Object>, List<MitName>> gewaehrungen = new LinkedHashMap<>();
        for (MitName m : zeilen) {
            Zeile x = m.zeile();
            if (x.rolle() != Rolle.UNTERSTUETZER || x.art() == null || !sichtbar.contains(x.standortKurzzeichen())) {
                continue;
            }
            gewaehrungen.computeIfAbsent(Arrays.asList(x.benutzerSub(), x.art(), x.umfang(), x.gueltigAb(),
                    x.gueltigBis(), x.endetAm(), x.beendetAm()), g -> new ArrayList<>()).add(m);
        }
        List<SelbstauskunftDto.Unterstuetzung> aus = new ArrayList<>();
        for (List<MitName> g : gewaehrungen.values()) {
            Zeile x = g.get(0).zeile();
            String name = g.get(0).name();
            List<String> an = k.standorte().stream().map(RechteAbleitung.Standort::kennzeichen)
                    .filter(s -> g.stream().anyMatch(m -> s.equals(m.zeile().standortKurzzeichen()))).toList();
            String grund = x.art() == Art.NOTFALL ? zugriffe.grundDerZuweisung(x.id()) : null;
            UnterstuetzungErgebnis e = RechteAbleitung.unterstuetzung(new RechteAbleitung.Unterstuetzung(x.art(),
                    x.umfang(), an, x.gueltigAb(), x.gueltigAb(), x.alsZuweisung().gueltigBis(), x.beendetAm(), null,
                    new RechteAbleitung.Unterstuetzer(name, null, name), grund), k, jetzt, zone);
            aus.add(new SelbstauskunftDto.Unterstuetzung(x.art().code(), code(x.umfang()), an, zeit(x.gueltigAb(), zone),
                    x.gueltigBis() == null ? null : x.gueltigBis().toString(), zeit(e.endet(), zone),
                    e.zustand().code(), e.erinnerung(), new SelbstauskunftDto.Person(x.benutzerSub(), name),
                    eigene ? e.bannerUnterstuetzer() : e.bannerKunde()));
        }
        return aus;
    }

    private static SelbstauskunftDto.Teilansicht teilansicht(TeilansichtErgebnis t) {
        return new SelbstauskunftDto.Teilansicht(t.sichtbar(), t.gesamt(), t.unternehmensebene(), t.teilansicht(),
                t.kopfzeile(), t.exportKopfzeile(), t.unternehmensweiteObjekte());
    }

    /** Anzeigename aus dem Token: {@code name}, sonst {@code preferred_username}, sonst das Subject. */
    private static String tokenName(Jwt jwt) {
        for (String claim : List.of("name", "preferred_username")) {
            Object wert = jwt.getClaims().get(claim);
            if (wert != null && !wert.toString().isBlank()) {
                return wert.toString().trim();
            }
        }
        return jwt.getSubject();
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : OffsetDateTime.ofInstant(t, zone);
    }

    private static String code(Code c) {
        return c == null ? null : c.code();
    }
}
