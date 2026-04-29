const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('sidepanel loads HeroSMS country availability with getPrices for the OpenAI service', () => {
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  assert.match(source, /action', 'getPrices'/);
  assert.match(source, /service', HERO_SMS_SERVICE_CODE/);
  assert.match(source, /const HERO_SMS_SERVICE_CODE = 'dr'/);
  assert.match(source, /collectHeroSmsCountryPrices/);
  assert.match(source, /heroSmsMaxPrice/);
  assert.match(source, /return price <= heroSmsMaxPrice/);
});

test('sidepanel refreshes HeroSMS country options after api key blur', () => {
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  assert.match(source, /inputHeroSmsApiKey\?\.addEventListener\('blur', \(\) => \{/);
  assert.match(source, /loadHeroSmsCountries\(\)\.catch\(\(\) => \{ \}\);/);
});

test('sidepanel refreshes HeroSMS country options after max price blur and persists the field', () => {
  const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const backgroundSource = fs.readFileSync('background.js', 'utf8');

  assert.match(html, /id="input-hero-sms-max-price"/);
  assert.match(sidepanelSource, /heroSmsMaxPrice: heroSmsMaxPriceValue/);
  assert.match(sidepanelSource, /inputHeroSmsMaxPrice\?\.addEventListener\('blur', \(\) => \{/);
  assert.match(backgroundSource, /heroSmsMaxPrice: null/);
  assert.match(backgroundSource, /case 'heroSmsMaxPrice':/);
});

test('sidepanel exposes HeroSMS balance query and code delay controls', () => {
  const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const backgroundSource = fs.readFileSync('background.js', 'utf8');

  assert.match(html, /id="btn-query-hero-sms-balance"/);
  assert.match(html, /id="display-hero-sms-balance"/);
  assert.match(html, /id="input-hero-sms-code-delay-seconds"/);
  assert.match(sidepanelSource, /type: 'QUERY_HERO_SMS_BALANCE'/);
  assert.match(sidepanelSource, /heroSmsCodeDelaySeconds: normalizeHeroSmsCodeDelaySeconds/);
  assert.match(backgroundSource, /heroSmsCodeDelaySeconds: 0/);
  assert.match(backgroundSource, /heroSmsBalance: null/);
});

test('sidepanel includes an Auto HeroSMS country option and persists auto mode', () => {
  const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
  const backgroundSource = fs.readFileSync('background.js', 'utf8');

  assert.match(sidepanelSource, /value=\"auto\">Auto/);
  assert.match(sidepanelSource, /heroSmsCountryAuto: Boolean\(heroSmsCountry\.auto\)/);
  assert.match(backgroundSource, /heroSmsCountryAuto: false/);
  assert.match(backgroundSource, /case 'heroSmsCountryAuto':/);
});
