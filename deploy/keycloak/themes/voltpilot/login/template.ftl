<#--
  VoltPilot login-theme template (Login-Screen Stufe 1, Konzept
  data/vp-login-screen-k3 §3/§7; Captain-Entscheide A/B/C vom 23.08.2026).

  Die Zweiteilung ist DIE Leitidee: der Login ist die erste Seite des PORTALS,
  keine Marketing-Buehne davor. Links die weisse Markenflaeche wie die
  Portal-Seitenleiste (Wortmarke auf WEISS - die Glas-Plakette und die
  Orbit-Animation sind ersatzlos entfallen, siehe unten), rechts die helle
  Flaeche mit EINER Karte aus denselben Tokens wie jede Portal-Karte. Am
  Telefon bleibt davon eine 56-px-Kopfzeile und die Karte.

  Vier Dinge, die man beim Anfassen wissen muss:

  1. DER DUNKELMODUS-BLOCK IST WEG. Das keycloak.v2-Original haengt bei
     `prefers-color-scheme: dark` die Klasse `pf-v5-theme-dark` an <html>; das
     eigene CSS deckte nur login.ftl ab, also kippten alle uebrigen
     Flow-Seiten in eine dunkle PatternFly-Palette (gemessen 2,1:1 und 1,3:1).
     Das Portal ist hell, der Login bleibt hell - `color-scheme: light` in
     css/voltpilot.css sagt es dem Browser zusaetzlich.

  2. DIE KARTE GEHOERT DEM TEMPLATE, nicht der einzelnen Seite. Jede geerbte
     Flow-Seite (register, terms, webauthn, select-authenticator, ...) rendert
     ihren Inhalt damit automatisch im richtigen Kleid, ohne dass wir sie
     ueberschreiben muessen.

  3. DIE SPRACHWAHL steht in der FUSSZEILE, nicht als <select> ueber dem
     Formular. Im Original war sie das ERSTE Bedienelement der Seite - mit
     offener Tastatur sah der Kunde "Deutsch" statt seines Formulars.

  4. `#kc-form-login` (in login.ftl) und `#kc-page-title` bleiben - an der
     ersten haengt js/register-link.js seinen "Konto erstellen"-Link.

  Beim Keycloak-Upgrade gegen das neue keycloak.v2-template.ftl re-diffen:
  Kopf, Skripte und die <#nested>-Abschnitte sind uebernommen, der Rumpf ist
  bewusst unser eigener.
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
       Hub-Kachel des Motivs) - genau die Rolle, die er auch im Favicon hat.
       Das Motiv ist das Energiefluss-Diagramm des Cockpits in den
       --vp-flow-*-Rollenfarben: das Bild, das der Kunde gleich bedient. -->
  <aside class="vpl-brand">
    <div class="vpl-brandhead">
      <img class="vpl-wordmark" src="${url.resourcesPath}/img/voltpilot-wordmark.png"
           alt="VoltPilot" width="640" height="152">
    </div>
    <div class="vpl-stage" aria-hidden="true">
      <p class="vpl-kicker">${msg("vpKicker")}</p>
      <h2 class="vpl-claim">${msg("vpClaim")}</h2>
      <p class="vpl-claim-sub">${msg("vpClaimSub")}</p>
      <svg class="vpl-flow" viewBox="0 0 420 372" role="img" aria-label="${msg("vpFlowAlt")}" focusable="false">
        <defs>
          <linearGradient id="vplHub" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#B8D4FF"/><stop offset=".5" stop-color="#7BA3F7"/><stop offset="1" stop-color="#5A8DE8"/>
          </linearGradient>
        </defs>
        <path class="spoke" d="M210 96 V146" stroke="var(--vpl-flow-pv)"/>
        <path class="spoke rev" d="M176 186 H112" stroke="var(--vpl-flow-batt)"/>
        <path class="spoke" d="M244 186 H308" stroke="var(--vpl-flow-load)"/>
        <path class="spoke" d="M210 226 V276" stroke="var(--vpl-flow-grid)"/>
        <rect x="176" y="152" width="68" height="68" rx="16" fill="url(#vplHub)"/>
        <path d="M215 160 L197 189 h11 l-2 21 l18 -29 h-11 z" fill="#fff"/>
        <circle cx="210" cy="62" r="30" fill="var(--vpl-flow-pv-soft)" stroke="var(--vpl-flow-pv)" stroke-width="2"/>
        <g stroke="var(--vpl-flow-pv)" stroke-width="2.2" stroke-linecap="round" fill="none"><circle cx="210" cy="62" r="6"/><path d="M210 48v4M210 72v4M196 62h4M220 62h4M200 52l2.8 2.8M217.2 69.2 220 72M220 52l-2.8 2.8M202.8 69.2 200 72"/></g>
        <text class="node-label" x="210" y="18" text-anchor="middle">${msg("vpNodeSolar")}</text>
        <text class="node-sub" x="210" y="33" text-anchor="middle">${msg("vpNodeSolarSub")}</text>
        <circle cx="78" cy="186" r="30" fill="var(--vpl-flow-batt-soft)" stroke="var(--vpl-flow-batt)" stroke-width="2"/>
        <g stroke="var(--vpl-flow-batt)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><rect x="64" y="179" width="24" height="14" rx="3"/><path d="M91 183v6"/><path d="M69 183v6h6v-6" fill="var(--vpl-flow-batt)" stroke="none"/></g>
        <text class="node-label" x="78" y="236" text-anchor="middle">${msg("vpNodeStorage")}</text>
        <text class="node-sub" x="78" y="251" text-anchor="middle">${msg("vpNodeStorageSub")}</text>
        <circle cx="342" cy="186" r="30" fill="var(--vpl-flow-load-soft)" stroke="var(--vpl-flow-load)" stroke-width="2"/>
        <g stroke="var(--vpl-flow-load)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M330 186l12-11 12 11"/><path d="M333 184v12h18v-12"/><path d="M339 196v-6h6v6"/></g>
        <text class="node-label" x="342" y="236" text-anchor="middle">${msg("vpNodeHouse")}</text>
        <text class="node-sub" x="342" y="251" text-anchor="middle">${msg("vpNodeHouseSub")}</text>
        <circle cx="210" cy="310" r="30" fill="var(--vpl-flow-grid-soft)" stroke="var(--vpl-flow-grid)" stroke-width="2"/>
        <g stroke="var(--vpl-flow-grid)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M202 322l8-24 8 24"/><path d="M199 309h22M201 316h18M205 303h10"/></g>
        <text class="node-label" x="210" y="357" text-anchor="middle">${msg("vpNodeGrid")}</text>
        <text class="node-sub" x="210" y="370" text-anchor="middle" font-size="11">${msg("vpNodeGridSub")}</text>
      </svg>
      <#-- Das Quartett ist die Inhaltsangabe der App, kein Marketing-Claim:
           die vier taeglichen Fragen in der Reihenfolge der Telefon-Leiste
           (anlageNav.BOTTOM_PRIORITY). -->
      <ul class="vpl-quartet">
        <li><span class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span><span><b>${msg("vpQCockpit")}</b>${msg("vpQCockpitSub")}</span></li>
        <li><span class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span><span><b>${msg("vpQPlan")}</b>${msg("vpQPlanSub")}</span></li>
        <li><span class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></span><span><b>${msg("vpQMeasure")}</b>${msg("vpQMeasureSub")}</span></li>
        <li><span class="q-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6.5A6 6 0 0 0 8 8H5m0 4h3m-3 4h3a6 6 0 0 0 9 1.5"/><path d="M5 12h9"/></svg></span><span><b>${msg("vpQRevenue")}</b>${msg("vpQRevenueSub")}</span></li>
      </ul>
    </div>
    <p class="vpl-brandfoot">${msg("vpBrandFoot")}</p>
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

    <ul class="vpl-quartet-line" aria-label="${msg("vpAfterLogin")}">
      <li><i style="background:var(--vpl-flow-pv)"></i>${msg("vpQCockpit")}</li>
      <li><i style="background:var(--vpl-flow-batt)"></i>${msg("vpQPlan")}</li>
      <li><i style="background:var(--vpl-flow-load)"></i>${msg("vpQMeasure")}</li>
      <li><i style="background:var(--vpl-flow-grid)"></i>${msg("vpQRevenue")}</li>
    </ul>

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
