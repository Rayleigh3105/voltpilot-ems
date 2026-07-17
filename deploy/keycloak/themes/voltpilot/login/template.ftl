<#--
  VoltPilot login-theme template override (captain-approved login redesign).

  Faithful copy of keycloak.v2's template.ftl (Keycloak 26.0.5 - the head,
  scripts, macros and the whole .pf-v5-c-login structure are byte-compatible,
  so every inherited flow page keeps working), plus ONE structural change:
  the page body is wrapped in the split view - left the pure brand stage on
  the --vp-grad-hero gradient (the ORIGINAL voltpilot.de orbit animation +
  the logo on a frosted glass plaque), right the original login container.
  Every flow (login, error, OTP, reset, ...) renders its card in the right
  pane; the login page itself is fully styled by css/voltpilot.css.

  When upgrading Keycloak, re-diff this file against the new keycloak.v2
  template.ftl (themes/src/main/resources/theme/keycloak.v2/login/) - only
  the vp-split wrapper and the vp-brand aside are ours.
-->
<#import "field.ftl" as field>
<#import "footer.ftl" as loginFooter>
<#macro username>
  <#assign label>
    <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
  </#assign>
  <@field.group name="username" label=label>
    <div class="${properties.kcInputGroup}">
      <div class="${properties.kcInputGroupItemClass} ${properties.kcFill}">
        <span class="${properties.kcInputClass} ${properties.kcFormReadOnlyClass}">
          <input id="kc-attempted-username" value="${auth.attemptedUsername}" readonly>
        </span>
      </div>
      <div class="${properties.kcInputGroupItemClass}">
        <button id="reset-login" class="${properties.kcFormPasswordVisibilityButtonClass} kc-login-tooltip" type="button"
              aria-label="${msg('restartLoginTooltip')}" onclick="location.href='${url.loginRestartFlowUrl}'">
            <i class="fa-sync-alt fas" aria-hidden="true"></i>
            <span class="kc-tooltip-text">${msg("restartLoginTooltip")}</span>
        </button>
      </div>
    </@field.group>
</#macro>

<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}"<#if realm.internationalizationEnabled> lang="${locale.currentLanguageTag}" dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <meta name="viewport" content="width=device-width, initial-scale=1">

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
        import { checkCookiesAndSetTimer } from "${url.resourcesPath}/js/authChecker.js";

        checkCookiesAndSetTimer(
            "${url.ssoLoginInOtherTabsUrl?no_esc}"
        );

        const DARK_MODE_CLASS = "pf-v5-theme-dark";
        const mediaQuery =window.matchMedia("(prefers-color-scheme: dark)");
        updateDarkMode(mediaQuery.matches);
        mediaQuery.addEventListener("change", (event) =>
          updateDarkMode(event.matches),
        );
        function updateDarkMode(isEnabled) {
          const { classList } = document.documentElement;
          if (isEnabled) {
            classList.add(DARK_MODE_CLASS);
          } else {
            classList.remove(DARK_MODE_CLASS);
          }
        }
    </script>
</head>

<body id="keycloak-bg" class="${properties.kcBodyClass!}">

<div class="vp-split">
  <#-- Brand stage: pure brand on the hero gradient - the voltpilot.de orbit
       (three rotating rings, category nodes counter-rotating so the icons
       stay upright, navy energy core) + the logo on a frosted glass plaque.
       Decorative for screen readers; the page identity stays in #kc-header
       (visually hidden by the stylesheet). -->
  <aside class="vp-brand" aria-hidden="true">
    <div class="vp-brandstage">
      <div class="vp-orbit-shell">
        <div class="vp-orbit">
          <div class="vp-orbit-ring vp-orbit-ring-1">
            <div class="vp-orbit-node n-top pv"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg></div>
            <div class="vp-orbit-node n-bot battery"><svg viewBox="0 0 24 24"><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/></svg></div>
          </div>
          <div class="vp-orbit-ring vp-orbit-ring-2">
            <div class="vp-orbit-node ring2 n-left home"><svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/></svg></div>
            <div class="vp-orbit-node ring2 n-right car"><svg viewBox="0 0 24 24"><path d="M5 16l2-6h10l2 6"/><rect x="4" y="16" width="16" height="4" rx="1"/><circle cx="7.5" cy="20" r="1"/><circle cx="16.5" cy="20" r="1"/></svg></div>
          </div>
          <div class="vp-orbit-ring vp-orbit-ring-3">
            <div class="vp-orbit-node ring3 n-top industry"><svg viewBox="0 0 24 24"><path d="M3 21V9l6 4V9l6 4V5h6v16z"/></svg></div>
            <div class="vp-orbit-node ring3 n-bot grid"><svg viewBox="0 0 24 24"><path d="M6 21V8l6-5 6 5v13M9 21v-6h6v6"/></svg></div>
          </div>
          <div class="vp-orbit-center"><div class="vp-orbit-center-inner"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg></div></div>
        </div>
      </div>
      <div class="vp-brand-glass">
        <img class="vp-brand-logo" src="${url.resourcesPath}/img/voltpilot-logo.png" alt="">
      </div>
    </div>
  </aside>

  <div class="vp-formside">
    <div class="${properties.kcLogin!}">
      <div class="${properties.kcLoginContainer!}">
        <header id="kc-header" class="pf-v5-c-login__header">
          <div id="kc-header-wrapper"
                  class="pf-v5-c-brand">${kcSanitize(msg("loginTitleHtml",(realm.displayNameHtml!'')))?no_esc}</div>
        </header>
        <main class="${properties.kcLoginMain!}">
          <div class="${properties.kcLoginMainHeader!}">
            <h1 class="${properties.kcLoginMainTitle!}" id="kc-page-title"><#nested "header"></h1>
            <#if realm.internationalizationEnabled  && locale.supported?size gt 1>
            <div class="${properties.kcLoginMainHeaderUtilities!}">
              <div class="${properties.kcInputClass!}">
                <select
                  aria-label="${msg("languages")}"
                  id="login-select-toggle"
                  onchange="if (this.value) window.location.href=this.value"
                >
                  <#list locale.supported?sort_by("label") as l>
                    <option
                      value="${l.url}"
                      ${(l.languageTag == locale.currentLanguageTag)?then('selected','')}
                    >
                      ${l.label}
                    </option>
                  </#list>
                </select>
                <span class="${properties.kcFormControlUtilClass}">
                  <span class="${properties.kcFormControlToggleIcon!}">
                    <svg
                      class="pf-v5-svg"
                      viewBox="0 0 320 512"
                      fill="currentColor"
                      aria-hidden="true"
                      role="img"
                      width="1em"
                      height="1em"
                    >
                      <path
                        d="M31.3 192h257.3c17.8 0 26.7 21.5 14.1 34.1L174.1 354.8c-7.8 7.8-20.5 7.8-28.3 0L17.2 226.1C4.6 213.5 13.5 192 31.3 192z"
                      >
                      </path>
                    </svg>
                  </span>
                </span>
              </div>
            </div>
            </#if>
          </div>
          <div class="${properties.kcLoginMainBody!}">
            <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
                <#if displayRequiredFields>
                    <div class="${properties.kcContentWrapperClass!}">
                        <div class="${properties.kcLabelWrapperClass!} subtitle">
                            <span class="${properties.kcInputHelperTextItemTextClass!}">
                              <span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}
                            </span>
                        </div>
                    </div>
                </#if>
            <#else>
                <#if displayRequiredFields>
                    <div class="${properties.kcContentWrapperClass!}">
                        <div class="${properties.kcLabelWrapperClass!} subtitle">
                            <span class="${properties.kcInputHelperTextItemTextClass!}">
                              <span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}
                            </span>
                        </div>
                        <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                            <#nested "show-username">
                            <@username />
                        </div>
                    </div>
                <#else>
                    <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                      <#nested "show-username">
                      <@username />
                    </div>
                </#if>
            </#if>

            <#-- App-initiated actions should not see warning messages about the need to complete the action -->
            <#-- during login.                                                                               -->
            <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                <div class="${properties.kcAlertClass!} pf-m-${(message.type = 'error')?then('danger', message.type)}">
                    <div class="${properties.kcAlertIconClass!}">
                        <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}"></span></#if>
                        <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}"></span></#if>
                        <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}"></span></#if>
                        <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}"></span></#if>
                    </div>
                    <span class="${properties.kcAlertTitleClass!} kc-feedback-text">${kcSanitize(message.summary)?no_esc}</span>
                </div>
            </#if>

            <#nested "form">

            <#if auth?has_content && auth.showTryAnotherWayLink()>
              <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" novalidate="novalidate">
                  <input type="hidden" name="tryAnotherWay" value="on"/>
                  <a id="try-another-way" href="javascript:document.forms['kc-select-try-another-way-form'].submit()"
                      class="${properties.kcButtonSecondaryClass} ${properties.kcButtonBlockClass} ${properties.kcMarginTopClass}">
                        ${kcSanitize(msg("doTryAnotherWay"))?no_esc}
                  </a>
              </form>
            </#if>

            <#if displayInfo>
              <div id="kc-info" class="${properties.kcSignUpClass!}">
                  <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                      <#nested "info">
                  </div>
              </div>
            </#if>
          </div>
          <div class="pf-v5-c-login__main-footer">
            <#nested "socialProviders">
          </div>
        </main>

        <@loginFooter.content/>
      </div>
    </div>
  </div>
</div>
</body>
</html>
</#macro>
