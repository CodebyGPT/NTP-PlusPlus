const extensionApi = globalThis.browser ?? globalThis.chrome;

export function t(key, substitutions) {
  const message = extensionApi?.i18n?.getMessage(key, substitutions);
  return message || key;
}

export function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }

  const language = extensionApi?.i18n?.getMessage('languageCode');
  if (language) {
    document.documentElement.lang = language;
  }
}
