<#--
  VoltPilot login-theme template (Login-Screen Stufe 1, Konzept
  data/vp-login-screen-k3, Captain-Entscheide A/B/C vom 23.08.2026; die Buehne
  „Kacheln“ kommt aus dem Login-Konzept vom 30.09.2026, Variante C mit der
  Telefon-Fassung C3).

  Die Zweiteilung bleibt DIE Leitidee: der Login ist die erste Seite des
  PORTALS, keine Marketing-Buehne davor. Links die weisse Markenflaeche wie die
  Portal-Seitenleiste, rechts die helle Flaeche mit EINER Karte aus denselben
  Tokens wie jede Portal-Karte. Am Telefon bleibt davon eine 56-px-Kopfzeile,
  die Karte und darunter EINE ruhige Kachel.

  Sechs Dinge, die man beim Anfassen wissen muss:

  1. DIE KACHELN SIND DIE INHALTSANGABE DES PORTALS, keine Anlage. Die Seite
     kennt noch keinen Kunden, also traegt sie KEINE Zahl (kein kW, kein Euro).
     Die Mini-Bilder in den Kacheln sind Formen, keine Werte.

  2. DIE BEWEGUNG HAT EINE UHR UND EINEN SCHALTER. Die Kacheln blenden EINMAL
     gestaffelt ein; danach wandert ein Lichtpunkt alle 2 s weiter (EIN
     Keyframe, je Kachel versetzt), die Laufpunkte im Cockpit laufen im
     Ruhetempo 1,8 s. Ein Knopf haelt beides an (WCAG 2.2.2), js/stage-motion.js
     merkt sich das im Browser; `prefers-reduced-motion` haelt es ohne Knopf an.
     Am Telefon bewegt sich nichts.

  3. DAS MOTIV IST DEKORATIV (`aria-hidden`), der Knopf ist es nicht - er
     steht deshalb AUSSERHALB der versteckten Teile. Ohne Skript bleibt er
     `hidden`; die Seite funktioniert ohne ihn unveraendert.

  4. DIE KARTE GEHOERT DEM TEMPLATE, nicht der einzelnen Seite. Jede geerbte
     Flow-Seite (register, terms, webauthn, select-authenticator, ...) rendert
     ihren Inhalt damit automatisch im richtigen Kleid.

  5. DIE SPRACHWAHL steht in der FUSSZEILE, nicht als <select> ueber dem
     Formular. Im Original war sie das ERSTE Bedienelement der Seite - mit
     offener Tastatur sah der Kunde "Deutsch" statt seines Formulars.

  6. `#kc-form-login` (in login.ftl) und `#kc-page-title` bleiben - an der
     ersten haengt js/register-link.js seinen "Konto erstellen"-Link.

  Das Portal traegt dieselbe Buehne in frontend/portal/src/components/
  AuthScreen.tsx; wer hier Copy, Motiv oder Takt aendert, aendert sie dort mit.
  Beim Keycloak-Upgrade gegen das neue keycloak.v2-template.ftl re-diffen:
  Kopf, Skripte und die <#nested>-Abschnitte sind uebernommen, der Rumpf ist
  bewusst unser eigener. Die Dunkelmodus-Logik des Originals ist entfallen:
  das Portal ist hell, der Login bleibt hell (`color-scheme: light` in
  css/voltpilot.css).
-->
<#import "field.ftl" as field>
<#macro username>
  <div class="vpl-field">
    <span class="vpl-label">${msg("vpAccountLabel")}</span>
    <div class="vpl-user-fixed">
      <span class="vpl-user-name" id="kc-attempted-username">${auth.attemptedUsername}</span>
      <a id="reset-login" class="vpl-link" href="${url.loginRestartFlowUrl}">${msg("vpOtherAccount")}</a>
    </div>
  </div>
</#macro>

<#-- Der Knopf, der die Buehne anhaelt. Er steht nur in der breiten Fassung -
     am Telefon bewegt sich nichts. js/stage-motion.js verdrahtet ihn. -->
<#macro motionToggle>
  <button type="button" class="vpl-motion" data-vp-motion hidden
          data-vp-pause="${msg("vpMotionPause")}" data-vp-play="${msg("vpMotionPlay")}">
    <span class="vpl-motion-ic" aria-hidden="true"></span>
    <span class="vpl-motion-label">${msg("vpMotionPause")}</span>
  </button>
</#macro>


<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}"<#if realm.internationalizationEnabled> lang="${locale.currentLanguageTag}" dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <#-- viewport-fit=cover ist die Voraussetzung dafuer, dass env(safe-area-inset-*)
         ueberhaupt einen Wert liefert (dieselbe Zeile traegt frontend/portal/index.html). -->
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    <script type="module">
        import { checkCookiesAndSetTimer } from "${url.resourcesCommonPath}/js/authChecker.js";

        checkCookiesAndSetTimer(
            "${url.ssoLoginInOtherTabsUrl?no_esc}"
        );
    </script>
</head>

<body id="keycloak-bg" class="${properties.kcBodyClass!}">

<div class="vpl">
  <div class="vpl-strip" aria-hidden="true"></div>

  <#-- Markenflaeche: Wortmarke auf WEISS wie die Portal-Seitenleiste. Der
       --vp-grad-hero-Verlauf bleibt als AKZENT (der 3-px-Streifen oben und die
       Hub-Kachel des Motivs) - genau die Rolle, die er auch im Favicon hat. -->
  <aside class="vpl-brand">
    <div class="vpl-brandhead">
      <img class="vpl-wordmark" src="${url.resourcesPath}/img/voltpilot-wordmark.png"
           alt="VoltPilot" width="640" height="152">
    </div>
    <div class="vpl-stage">
      <div class="vpl-intro" aria-hidden="true">
        <p class="vpl-kicker">${msg("vpKicker")}</p>
        <h2 class="vpl-claim">${msg("vpClaim")}</h2>
        <p class="vpl-claim-sub">${msg("vpClaimSub")}</p>
      </div>

      <div class="vpl-scene">
        <#-- Alle Flaechen des Portals als Kacheln. Sie blenden EINMAL gestaffelt
             ein (30 ms je Kachel); danach wandert EIN Lichtpunkt alle 2 s weiter
             (ein Keyframe, je Kachel um 2 s versetzt). Keine Zahl: die Seite kennt
             noch keine Anlage. -->
        <svg class="vpl-defs" aria-hidden="true" focusable="false"><defs>
          <linearGradient id="vplHub" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B8D4FF"/><stop offset=".5" stop-color="#7BA3F7"/><stop offset="1" stop-color="#5A8DE8"/></linearGradient>
        </defs></svg>
        <div class="vpl-tiles" aria-hidden="true">
        <div class="vpl-tile vpl-t0 is-wide">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg></span><b>${msg("vpTileCockpit")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileCockpitSub")}</span>
          <svg class="vpl-mini vpl-mini-flow" viewBox="0 0 300 40" focusable="false">
            <path class="vpl-mini-track" d="M34 20 H132 M168 20 H266"/>
            <path class="vpl-fl" d="M34 20 H132" stroke="var(--vpl-flow-pv)"/><path class="vpl-fl" d="M168 20 H266" stroke="var(--vpl-flow-load)"/>
            <g class="vpl-arrow"><path d="M80 15 L86 20 L80 25" stroke="var(--vpl-flow-pv)"/><path d="M214 15 L220 20 L214 25" stroke="var(--vpl-flow-load)"/></g>
            <circle cx="18" cy="20" r="15" fill="var(--vpl-flow-pv-soft)" stroke="var(--vpl-flow-pv)" stroke-width="2"/><circle cx="18" cy="20" r="4" fill="none" stroke="var(--vpl-flow-pv)" stroke-width="2"/>
            <rect x="132" y="2" width="36" height="36" rx="10" fill="url(#vplHub)"/><path d="M153 7 L143 23 h6 l-1 11 l10 -16 h-6 z" fill="#fff"/>
            <circle cx="282" cy="20" r="15" fill="var(--vpl-flow-load-soft)" stroke="var(--vpl-flow-load)" stroke-width="2"/><path d="M275 21 L282 15 L289 21 V27 H275 Z" fill="none" stroke="var(--vpl-flow-load)" stroke-width="2" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="vpl-tile vpl-t1">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/></svg></span><b>${msg("vpTileHistory")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileHistorySub")}</span>
          <svg class="vpl-mini vpl-mini-bars" viewBox="0 0 120 28" focusable="false"><path d="M0 28V12h12v16zM18 28V6h12v22zM36 28V14h12v14zM54 28V3h12v25zM72 28V9h12v19zM90 28V16h12v12zM108 28V7h12v21z"/></svg>
        </div>
        <div class="vpl-tile vpl-t2">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg></span><b>${msg("vpTileForecast")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileForecastSub")}</span>
          <svg class="vpl-mini vpl-mini-curve" viewBox="0 0 120 28" focusable="false"><path d="M0 27 C 30 27, 38 3, 60 3 S 90 27, 120 27 Z"/></svg>
        </div>
        <div class="vpl-tile vpl-t3 is-wide">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg></span><b>${msg("vpTilePlan")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTilePlanSub")}</span>
          <span class="vpl-mini vpl-mini-plan"><svg viewBox="0 0 300 10" preserveAspectRatio="none" focusable="false"><rect class="is-cheap" x="0" width="62" height="10" rx="2"/><rect class="is-wait" x="64" width="60" height="10" rx="2"/><rect class="is-sun" x="126" width="62" height="10" rx="2"/><rect class="is-wait" x="190" width="22" height="10" rx="2"/><rect class="is-cover" x="214" width="74" height="10" rx="2"/><rect class="is-wait" x="290" width="10" height="10" rx="2"/></svg><span class="vpl-plan-legend"><span>${msg("vpPlanCheap")}</span><span>${msg("vpPlanSun")}</span><span>${msg("vpPlanCover")}</span></span></span>
        </div>
        <div class="vpl-tile vpl-t4">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M4 10h12M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/></svg></span><b>${msg("vpTilePrices")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTilePricesSub")}</span>
          <svg class="vpl-mini vpl-mini-step" viewBox="0 0 120 24" focusable="false"><path d="M0 18 H15 V20 H30 V10 H45 V4 H60 V14 H75 V20 H90 V6 H105 V2 H120"/></svg>
        </div>
        <div class="vpl-tile vpl-t5">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg></span><b>${msg("vpTileControl")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileControlSub")}</span>
          <span class="vpl-mini vpl-mini-toggles"><i class="is-on"></i><i></i><i class="is-on"></i></span>
        </div>
        <div class="vpl-tile vpl-t6">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M22 7 13.5 15.5 8.5 10.5 2 17M16 7h6v6"/></svg></span><b>${msg("vpTileRevenue")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileRevenueSub")}</span>
        </div>
        <div class="vpl-tile vpl-t7">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></span><b>${msg("vpTileKpis")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileKpisSub")}</span>
        </div>
        <div class="vpl-tile vpl-t8">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h6"/></svg></span><b>${msg("vpTileReports")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileReportsSub")}</span>
        </div>
        <div class="vpl-tile vpl-t9">
          <span class="vpl-tile-head"><span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg></span><b>${msg("vpTileSites")}</b></span>
          <span class="vpl-tile-sub">${msg("vpTileSitesSub")}</span>
        </div>
        </div>
      </div>
      <div class="vpl-stage-foot">
        <p class="vpl-footnote" aria-hidden="true">${msg("vpFootnote")}</p>
        <@motionToggle />
      </div>
    </div>
  </aside>

  <main class="vpl-panel">
    <div class="vpl-card">
      <#-- Die globale Meldung steht UEBER dem Titel: sie ist der Grund, warum
           diese Seite gerade so aussieht. Eine FELD-Meldung wird hier nicht
           gezeigt - login.ftl setzt displayMessage=false und haengt sie inline
           ans betroffene Feld (per aria-describedby). -->
      <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
          <div class="vpl-alert is-${(message.type = 'error')?then('err', (message.type = 'success')?then('ok', (message.type = 'warning')?then('warn','info')))}"
               role="${(message.type = 'error')?then('alert','status')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>
              <span class="kc-feedback-text">${kcSanitize(message.summary)?no_esc}</span>
          </div>
      </#if>

      <h1 class="vpl-title" id="kc-page-title"><#nested "header"></h1>

      <#-- Der Untertitel ist ein EIGENER Abschnitt, damit er direkt unter dem
           Titel steht - auch auf der Re-Auth-Seite, wo zwischen Titel und
           Formular die feste Konto-Zeile liegt. Als erstes Element von "form"
           haette er dort UNTER dem Konto gestanden (im Browser aufgefallen).
           Die Seite liefert den ganzen <p class="vpl-hint">-Absatz, nicht nur
           den Text: eine hier gewickelte Huelle waere bei einer Seite OHNE
           Abschnitt ein leerer Absatz, und ihn per <#assign> abzufangen geht
           nicht - bei aktivem Output-Format ist das Ergebnis Markup, das
           ?trim nicht annimmt (500 beim Bau). -->
      <#nested "hint">

      <#if displayRequiredFields>
          <p class="vpl-helper"><span class="vpl-req">*</span> ${msg("requiredFields")}</p>
      </#if>

      <#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
          <#nested "show-username">
          <@username />
      </#if>

      <#nested "form">

      <#if auth?has_content && auth.showTryAnotherWayLink()>
        <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" novalidate="novalidate">
            <input type="hidden" name="tryAnotherWay" value="on"/>
            <a id="try-another-way" class="vpl-secondary" href="javascript:document.forms['kc-select-try-another-way-form'].submit()">
              ${kcSanitize(msg("doTryAnotherWay"))?no_esc}
            </a>
        </form>
      </#if>

      <#if displayInfo>
        <div id="kc-info" class="vpl-info">
            <div id="kc-info-wrapper"><#nested "info"></div>
        </div>
      </#if>

      <div class="vpl-social"><#nested "socialProviders"></div>
    </div>

    <#-- Die Telefon-Fassung: EINE ruhige Kachel unter der Karte (Variante C3).
         Das Formular fuehrt, nichts bewegt sich. -->
    <div class="vpl-onetile" aria-hidden="true">
      <span class="vpl-tile-ic"><svg viewBox="0 0 24 24"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg></span>
      <span class="vpl-onetile-text"><b>${msg("vpOneTile")}</b><span>${msg("vpOneTileSub")}</span></span>
    </div>

    <footer class="vpl-foot">
      <#if realm.internationalizationEnabled && locale.supported?size gt 1>
        <span class="vpl-lang">
          <#list locale.supported?sort_by("label") as l>
            <#if l.languageTag == locale.currentLanguageTag>
              <span aria-current="true">${l.label}</span>
            <#else>
              <a href="${l.url}" hreflang="${l.languageTag}" lang="${l.languageTag}">${l.label}</a>
            </#if>
            <#sep><span class="sep" aria-hidden="true">·</span></#sep>
          </#list>
        </span>
      <#else>
        <span></span>
      </#if>
      <span class="vpl-foot-brand">${msg("vpBrandFoot")}</span>
    </footer>
  </main>
</div>
</body>
</html>
</#macro>
