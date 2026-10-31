import assert from 'node:assert/strict';

globalThis.chrome = {
  i18n: {
    getMessage(key) {
      if (key === 'known') return 'Known';
      if (key === 'languageCode') return 'ru';
      return '';
    },
  },
};

const { applyTranslations, t } = await import('../src/i18n.js');

assert.equal(t('known'), 'Known');
assert.equal(t('missing'), 'missing');

const title = { dataset: { i18n: 'known' }, textContent: '' };
const ariaButton = {
  dataset: { i18nAria: 'known' },
  attributes: {},
  setAttribute(name, value) {
    this.attributes[name] = value;
  },
};
globalThis.document = {
  documentElement: { lang: 'en' },
  querySelectorAll(selector) {
    if (selector === '[data-i18n]') return [title];
    if (selector === '[data-i18n-aria]') return [ariaButton];
    return [];
  },
};

applyTranslations();
assert.equal(title.textContent, 'Known');
assert.equal(ariaButton.attributes['aria-label'], 'Known');
assert.equal(document.documentElement.lang, 'ru');

console.log('i18n helper checks passed');
