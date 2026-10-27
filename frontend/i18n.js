// Idioma de la web: español (por defecto) e inglés.
// Cada texto traducible tiene data-i18n="clave" y su original en español queda en el HTML.
// La preferencia se guarda solo en este navegador (no es un dato de la cuenta).
(function () {
  const EN = {
    nav_features: 'Features',
    nav_how: 'How it works',
    nav_pricing: 'Pricing',
    nav_login: 'Sign in',
    hero_badge: '<span class="hero-badge-dot"></span> For Lua and Luau script creators',
    hero_title: 'Protect your scripts<br>with pro-grade security',
    hero_sub: 'Protect your scripts, generate and manage HWID-bound keys, and control access from a <strong>web panel</strong> and a <strong>Discord bot</strong>.',
    cta_start: 'Get started',
    cta_features: 'See features',
    features_title: 'Everything you need<br>to <em>protect your script</em>',
    how_title: 'From zero to protected<br>in under <em>2 minutes</em>',
    pricing_title: 'Plans for <em>every scale</em>',
    faq_title: 'Frequently asked <em>questions</em>',
    faq_q1: 'What is Vantarmor?',
    faq_a1: 'A system to protect Lua and Luau scripts with HWID-bound keys and access control from the web panel and the Discord bot.',
    faq_q2: 'Do I have to change the loader when I update my script?',
    faq_a2: 'No. Uploading a new version replaces the current code and the loader stays the same.',
    faq_q3: 'How do keys work?',
    faq_a3: 'Each key can be bound to a device (HWID) and can have an expiration date. You decide how many to generate and who gets them.',
    faq_q4: 'What happens during maintenance?',
    faq_a4: 'Normal maintenance pauses purchases, redemptions and new scripts, and the website shows a notice. Full maintenance also pauses the loaders and the bot.',
    faq_q5: 'How often do plan limits reset?',
    faq_a5: 'The Free plan resets every 15 days. Premium and Premium Plus renew every month.',
    faq_q6: 'Do I need Discord to use it?',
    faq_a6: 'The web panel does everything. The Discord bot lets your users claim keys and check their access.',
    cta_title: 'Ready to protect your script?',
    login_title: 'Welcome back',
    login_subtitle: 'Sign in to access your dashboard',
    login_discord: 'Continue with Discord',
    login_divider: 'or with email',
    login_email: 'Email',
    login_password: 'Password',
    login_submit: 'Sign in',
    login_forgot: 'Forgot your password?',
    login_register: 'Create account',
    login_back: 'Back',
    login_soon: 'Email sign-in is coming soon. Use Discord for now.',
    login_err_no_code: 'No code was received from Discord',
    login_err_token: 'Failed to get the token',
    login_err_server: 'Internal server error',
    login_err_default: 'Sign-in error',
  };
  const KEY = 'vm-lang';
  const readSaved = () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } };
  const saveLang = v => { try { localStorage.setItem(KEY, v); } catch (_) { /* navegador sin almacenamiento: no pasa nada */ } };
  const browserLang = (navigator.language || 'es').slice(0, 2).toLowerCase();
  let lang = readSaved() || (browserLang === 'en' ? 'en' : 'es');

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      if (el.dataset.esHtml === undefined) el.dataset.esHtml = el.innerHTML;
      el.innerHTML = lang === 'en' && EN[el.dataset.i18n] ? EN[el.dataset.i18n] : el.dataset.esHtml;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      if (el.dataset.esPh === undefined) el.dataset.esPh = el.placeholder;
      el.placeholder = lang === 'en' && EN[el.dataset.i18nPh] ? EN[el.dataset.i18nPh] : el.dataset.esPh;
    });
    const btn = document.getElementById('langToggle');
    if (btn) btn.textContent = lang === 'en' ? 'ES' : 'EN';
  }

  window.vmLang = () => lang;
  // Texto para scripts JS (mensajes de error, etc.). Devuelve null si el idioma es español.
  window.vmT = key => (lang === 'en' && EN[key]) || null;
  window.vmSetLang = next => { lang = next; saveLang(next); apply(); };

  const start = () => {
    apply();
    const btn = document.getElementById('langToggle');
    if (btn) btn.addEventListener('click', () => window.vmSetLang(lang === 'en' ? 'es' : 'en'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
