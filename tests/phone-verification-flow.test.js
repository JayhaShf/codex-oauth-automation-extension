const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/phone-verification-flow.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPhoneVerification;`)(globalScope);

test('phone verification helper requests HeroSMS numbers with fixed OpenAI and Thailand parameters', async () => {
  const requests = [];
  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      if (action === 'getPrices') {
        return { ok: true, text: async () => JSON.stringify({ 52: { cost: '0.10' } }) };
      }
      if (action === 'getCountries') {
        return { ok: true, text: async () => JSON.stringify([{ id: 52, eng: 'Thailand', visible: 1 }]) };
      }
      if (action === 'getBalance') {
        return { ok: true, text: async () => 'ACCESS_BALANCE:5.0000' };
      }
      return {
        ok: true,
        text: async () => 'ACCESS_NUMBER:123456:66959916439',
      };
    },
    getState: async () => ({ heroSmsApiKey: 'demo-key' }),
    sendToContentScriptResilient: async () => ({}),
    setState: async () => {},
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const activation = await helpers.requestPhoneActivation({ heroSmsApiKey: 'demo-key' });

  assert.deepStrictEqual(activation, {
    activationId: '123456',
    phoneNumber: '66959916439',
    provider: 'hero-sms',
    serviceCode: 'dr',
    countryId: 52,
    successfulUses: 0,
    maxUses: 3,
  });
  assert.equal(requests.length, 4);
  assert.deepStrictEqual(requests.map((url) => url.searchParams.get('action')), ['getPrices', 'getCountries', 'getBalance', 'getNumber']);
  assert.equal(requests[3].searchParams.get('service'), 'dr');
  assert.equal(requests[3].searchParams.get('country'), '52');
  assert.equal(requests[3].searchParams.get('api_key'), 'demo-key');
});

test('phone verification helper completes add-phone flow, clears current activation, and stores reusable number state', async () => {
  const requests = [];
  const stateUpdates = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    verificationResendCount: 1,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      if (action === 'getPrices') {
        return { ok: true, text: async () => JSON.stringify({ 52: { cost: '0.10' } }) };
      }
      if (action === 'getCountries') {
        return { ok: true, text: async () => JSON.stringify([{ id: 52, eng: 'Thailand', visible: 1 }]) };
      }
      if (action === 'getBalance') {
        return { ok: true, text: async () => 'ACCESS_BALANCE:5.0000' };
      }
      if (action === 'getNumber') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:123456:66959916439',
        };
      }
      if (action === 'getStatus') {
        return {
          ok: true,
          text: async () => 'STATUS_OK:654321',
        };
      }
      if (action === 'setStatus') {
        return {
          ok: true,
          text: async () => 'ACCESS_ACTIVATION',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}`);
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
        return {
          success: true,
          consentReady: true,
          url: 'https://auth.openai.com/authorize',
        };
      }
      throw new Error(`Unexpected content-script message: ${message.type}`);
    },
    setState: async (updates) => {
      stateUpdates.push(updates);
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await helpers.completePhoneVerificationFlow(1, {
    addPhonePage: true,
    phoneVerificationPage: false,
    url: 'https://auth.openai.com/add-phone',
  });

  assert.deepStrictEqual(result, {
    success: true,
    consentReady: true,
    url: 'https://auth.openai.com/authorize',
  });
  assert.deepStrictEqual(stateUpdates, [
    {
      heroSmsBalance: 5,
    },
    {
      currentPhoneActivation: {
        activationId: '123456',
        phoneNumber: '66959916439',
        provider: 'hero-sms',
        serviceCode: 'dr',
        countryId: 52,
        successfulUses: 0,
        maxUses: 3,
      },
    },
    {
      reusablePhoneActivation: {
        activationId: '123456',
        phoneNumber: '66959916439',
        provider: 'hero-sms',
        serviceCode: 'dr',
        countryId: 52,
        successfulUses: 1,
        maxUses: 3,
      },
    },
    {
      currentPhoneActivation: null,
    },
  ]);

  const actions = requests.map((url) => url.searchParams.get('action'));
  assert.deepStrictEqual(actions, ['getPrices', 'getCountries', 'getBalance', 'getNumber', 'getStatus', 'setStatus']);
});

test('phone verification helper uses the configured HeroSMS country for both number acquisition and add-phone submission', async () => {
  const requests = [];
  const submittedPayloads = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      if (action === 'getPrices') {
        return { ok: true, text: async () => JSON.stringify({ 16: { cost: '0.10' } }) };
      }
      if (action === 'getCountries') {
        return { ok: true, text: async () => JSON.stringify([{ id: 16, eng: 'United Kingdom', visible: 1 }]) };
      }
      if (action === 'getBalance') {
        return { ok: true, text: async () => 'ACCESS_BALANCE:5.0000' };
      }
      if (action === 'getNumber') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:654321:447911123456',
        };
      }
      if (action === 'getStatus') {
        return {
          ok: true,
          text: async () => 'STATUS_OK:112233',
        };
      }
      if (action === 'setStatus') {
        return {
          ok: true,
          text: async () => 'ACCESS_ACTIVATION',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}`);
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        submittedPayloads.push(message.payload);
        return {
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
        return {
          success: true,
          consentReady: true,
          url: 'https://auth.openai.com/authorize',
        };
      }
      throw new Error(`Unexpected content-script message: ${message.type}`);
    },
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await helpers.completePhoneVerificationFlow(1, {
    addPhonePage: true,
    phoneVerificationPage: false,
    url: 'https://auth.openai.com/add-phone',
  });

  assert.deepStrictEqual(result, {
    success: true,
    consentReady: true,
    url: 'https://auth.openai.com/authorize',
  });
  const getNumberRequest = requests.find((url) => url.searchParams.get('action') === 'getNumber');
  assert.equal(getNumberRequest?.searchParams.get('country'), '16');
  assert.deepStrictEqual(submittedPayloads, [{
    phoneNumber: '447911123456',
    countryId: 16,
    countryLabel: 'United Kingdom',
  }]);
});

test('phone verification helper reports the configured HeroSMS country when number acquisition fails', async () => {
  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async () => ({
      ok: true,
      text: async () => 'NO_NUMBERS',
    }),
    getState: async () => ({
      heroSmsApiKey: 'demo-key',
      heroSmsCountryId: 16,
      heroSmsCountryLabel: 'United Kingdom',
    }),
    sendToContentScriptResilient: async () => ({}),
    setState: async () => {},
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  await assert.rejects(
    helpers.requestPhoneActivation({
      heroSmsApiKey: 'demo-key',
      heroSmsCountryId: 16,
      heroSmsCountryLabel: 'United Kingdom',
    }),
    /HeroSMS getNumber failed for United Kingdom \(16\): NO_NUMBERS/
  );
});

test('phone verification helper preselects an available country before the first getNumber request', async () => {
  const requests = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
    heroSmsMaxPrice: 0.2,
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    broadcastDataUpdate: () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      if (action === 'getPrices') {
        return {
          ok: true,
          text: async () => JSON.stringify({ 52: { cost: '0.10' } }),
        };
      }
      if (action === 'getCountries') {
        return {
          ok: true,
          text: async () => JSON.stringify([{ id: 52, eng: 'Thailand', visible: 1 }]),
        };
      }
      if (action === 'getBalance') {
        return {
          ok: true,
          text: async () => 'ACCESS_BALANCE:5.0000',
        };
      }
      if (action === 'getNumber') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:999999:66950000009',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}`);
    },
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async () => ({}),
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const activation = await helpers.requestPhoneActivation(currentState);

  assert.equal(activation.phoneNumber, '66950000009');
  assert.equal(currentState.heroSmsCountryId, 52);
  assert.deepStrictEqual(
    requests.filter((url) => url.searchParams.get('action') === 'getNumber').map((url) => url.searchParams.get('country')),
    ['52']
  );
});

test('phone verification helper queries and parses HeroSMS balance', async () => {
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
  };
  const broadcasts = [];

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    broadcastDataUpdate: (payload) => broadcasts.push(payload),
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.searchParams.get('action') === 'getBalance') {
        return {
          ok: true,
          text: async () => 'ACCESS_BALANCE:3.2100',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${parsedUrl.searchParams.get('action')}`);
    },
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async () => ({}),
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const balance = await helpers.queryHeroSmsBalance(currentState);

  assert.equal(balance, 3.21);
  assert.equal(currentState.heroSmsBalance, 3.21);
  assert.deepStrictEqual(broadcasts, [{ heroSmsBalance: 3.21 }]);
});

test('phone verification helper automatically switches to another available HeroSMS country when the selected country has no number pool', async () => {
  const requests = [];
  const submittedPayloads = [];
  const broadcasts = [];
  const logs = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
    heroSmsMaxPrice: 0.2,
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async (message, level) => {
      logs.push({ message, level });
    },
    broadcastDataUpdate: (payload) => {
      broadcasts.push(payload);
    },
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      const country = parsedUrl.searchParams.get('country');
      if (action === 'getNumber' && country === '16') {
        return {
          ok: true,
          text: async () => 'NO_NUMBERS',
        };
      }
      if (action === 'getPrices') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            52: { cost: '0.10' },
            43: { cost: '0.30' },
          }),
        };
      }
      if (action === 'getCountries') {
        return {
          ok: true,
          text: async () => JSON.stringify([
            { id: 16, eng: 'United Kingdom', visible: 1 },
            { id: 52, eng: 'Thailand', visible: 1 },
            { id: 43, eng: 'Germany', visible: 1 },
          ]),
        };
      }
      if (action === 'getNumber' && country === '52') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:654321:66959916439',
        };
      }
      if (action === 'getStatus') {
        return {
          ok: true,
          text: async () => 'STATUS_OK:112233',
        };
      }
      if (action === 'setStatus') {
        return {
          ok: true,
          text: async () => 'ACCESS_ACTIVATION',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}:${country || ''}`);
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        submittedPayloads.push(message.payload);
        return {
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
        return {
          success: true,
          consentReady: true,
          url: 'https://auth.openai.com/authorize',
        };
      }
      throw new Error(`Unexpected content-script message: ${message.type}`);
    },
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await helpers.completePhoneVerificationFlow(1, {
    addPhonePage: true,
    phoneVerificationPage: false,
    url: 'https://auth.openai.com/add-phone',
  });

  assert.deepStrictEqual(result, {
    success: true,
    consentReady: true,
    url: 'https://auth.openai.com/authorize',
  });
  assert.deepStrictEqual(submittedPayloads, [{
    phoneNumber: '66959916439',
    countryId: 52,
    countryLabel: 'Thailand',
  }]);
  assert.ok(Array.isArray(logs), 'logs should remain collectable during automatic country selection');
  assert.deepStrictEqual(broadcasts, [{
    heroSmsCountryId: 52,
    heroSmsCountryLabel: 'Thailand',
  }]);
  assert.equal(currentState.heroSmsCountryId, 52);
  assert.equal(currentState.heroSmsCountryLabel, 'Thailand');
  assert.deepStrictEqual(
    requests.filter((url) => url.searchParams.get('action') === 'getNumber').map((url) => url.searchParams.get('country')),
    ['52']
  );
});

test('phone verification helper prefers same-region countries before lower-priced countries in other regions', async () => {
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
    heroSmsMaxPrice: 0.2,
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const requests = [];
  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    broadcastDataUpdate: () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      const country = parsedUrl.searchParams.get('country');
      if (action === 'getNumber' && country === '16') {
        return {
          ok: true,
          text: async () => 'NO_NUMBERS',
        };
      }
      if (action === 'getPrices') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            23: { cost: '0.12' },
            52: { cost: '0.10' },
            43: { cost: '0.11' },
          }),
        };
      }
      if (action === 'getCountries') {
        return {
          ok: true,
          text: async () => JSON.stringify([
            { id: 16, eng: 'United Kingdom', visible: 1 },
            { id: 23, eng: 'Ireland', visible: 1 },
            { id: 43, eng: 'Germany', visible: 1 },
            { id: 52, eng: 'Thailand', visible: 1 },
          ]),
        };
      }
      if (action === 'getNumber' && country === '43') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:777777:4915112345678',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}:${country || ''}`);
    },
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async () => ({}),
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const activation = await helpers.requestPhoneActivation(currentState);

  assert.equal(activation.phoneNumber, '4915112345678');
  assert.equal(currentState.heroSmsCountryId, 43);
  assert.equal(currentState.heroSmsCountryLabel, 'Germany');
  assert.deepStrictEqual(
    requests.filter((url) => url.searchParams.get('action') === 'getNumber').map((url) => url.searchParams.get('country')),
    ['43']
  );
});

test('phone verification helper also switches countries when HeroSMS returns a structured out-of-stock message', async () => {
  let currentState = {
    heroSmsApiKey: 'demo-key',
    heroSmsCountryId: 16,
    heroSmsCountryLabel: 'United Kingdom',
    heroSmsMaxPrice: 0.2,
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    broadcastDataUpdate: () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      const action = parsedUrl.searchParams.get('action');
      const country = parsedUrl.searchParams.get('country');
      if (action === 'getNumber' && country === '16') {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: 'false', msg: 'Selected country is out of stock' }),
        };
      }
      if (action === 'getPrices') {
        return {
          ok: true,
          text: async () => JSON.stringify({ 52: { cost: '0.10' } }),
        };
      }
      if (action === 'getCountries') {
        return {
          ok: true,
          text: async () => JSON.stringify([
            { id: 16, eng: 'United Kingdom', visible: 1 },
            { id: 52, eng: 'Thailand', visible: 1 },
          ]),
        };
      }
      if (action === 'getNumber' && country === '52') {
        return {
          ok: true,
          text: async () => 'ACCESS_NUMBER:888888:66950000003',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}:${country || ''}`);
    },
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async () => ({}),
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const activation = await helpers.requestPhoneActivation(currentState);

  assert.equal(activation.phoneNumber, '66950000003');
  assert.equal(currentState.heroSmsCountryId, 52);
  assert.equal(currentState.heroSmsCountryLabel, 'Thailand');
});

test('phone verification helper replaces the number after 60 seconds plus one resend window without SMS', async () => {
  const requests = [];
  const messages = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };
  const statusCallsById = {};
  const realDateNow = Date.now;
  let fakeNow = 0;
  let numberIndex = 0;
  Date.now = () => fakeNow;

  try {
    const helpers = api.createPhoneVerificationHelpers({
      addLog: async () => {},
      ensureStep8SignupPageReady: async () => {},
      fetchImpl: async (url) => {
        const parsedUrl = new URL(url);
        requests.push(parsedUrl);
        const action = parsedUrl.searchParams.get('action');
        const id = parsedUrl.searchParams.get('id');

        if (action === 'getPrices') {
          return { ok: true, text: async () => JSON.stringify({ 52: { cost: '0.10' } }) };
        }
        if (action === 'getCountries') {
          return { ok: true, text: async () => JSON.stringify([{ id: 52, eng: 'Thailand', visible: 1 }]) };
        }
        if (action === 'getBalance') {
          return { ok: true, text: async () => 'ACCESS_BALANCE:5.0000' };
        }
        if (action === 'getNumber') {
          numberIndex += 1;
          return {
            ok: true,
            text: async () => numberIndex === 1
              ? 'ACCESS_NUMBER:123456:66959916439'
              : 'ACCESS_NUMBER:234567:66959916440',
          };
        }

        if (action === 'getStatus') {
          statusCallsById[id] = (statusCallsById[id] || 0) + 1;
          return {
            ok: true,
            text: async () => id === '123456' ? 'STATUS_WAIT_CODE' : 'STATUS_OK:654321',
          };
        }

        if (action === 'setStatus') {
          return {
            ok: true,
            text: async () => 'ACCESS_ACTIVATION',
          };
        }

        throw new Error(`Unexpected HeroSMS action: ${action}`);
      },
      getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
      getState: async () => ({ ...currentState }),
      sendToContentScriptResilient: async (_source, message) => {
        messages.push(message.type);
        if (message.type === 'SUBMIT_PHONE_NUMBER') {
          return {
            phoneVerificationPage: true,
            url: 'https://auth.openai.com/phone-verification',
          };
        }
        if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
          return {
            success: true,
            consentReady: true,
            url: 'https://auth.openai.com/authorize',
          };
        }
        if (message.type === 'RESEND_PHONE_VERIFICATION_CODE') {
          return {
            resent: true,
            url: 'https://auth.openai.com/phone-verification',
          };
        }
        if (message.type === 'RETURN_TO_ADD_PHONE') {
          return {
            addPhonePage: true,
            phoneVerificationPage: false,
            url: 'https://auth.openai.com/add-phone',
          };
        }
        throw new Error(`Unexpected content-script message: ${message.type}`);
      },
      setState: async (updates) => {
        currentState = { ...currentState, ...updates };
      },
      sleepWithStop: async () => {
        fakeNow += 61000;
      },
      throwIfStopped: () => {},
    });

    const result = await helpers.completePhoneVerificationFlow(1, {
      addPhonePage: true,
      phoneVerificationPage: false,
      url: 'https://auth.openai.com/add-phone',
    });
    assert.deepStrictEqual(result, {
      success: true,
      consentReady: true,
      url: 'https://auth.openai.com/authorize',
    });
    assert.ok(statusCallsById['123456'] >= 2, 'first number should be polled twice before being replaced');
    assert.deepStrictEqual(messages, [
      'SUBMIT_PHONE_NUMBER',
      'RESEND_PHONE_VERIFICATION_CODE',
      'RETURN_TO_ADD_PHONE',
      'SUBMIT_PHONE_NUMBER',
      'SUBMIT_PHONE_VERIFICATION_CODE',
    ]);

    const actions = requests.map((url) => `${url.searchParams.get('action')}:${url.searchParams.get('id') || ''}`);
    assert.deepStrictEqual(actions, [
      'getPrices:',
      'getCountries:',
      'getBalance:',
      'getNumber:',
      'getStatus:123456',
      'setStatus:123456',
      'getStatus:123456',
      'setStatus:123456',
      'getPrices:',
      'getCountries:',
      'getBalance:',
      'getNumber:',
      'getStatus:234567',
      'setStatus:234567',
    ]);
    assert.equal(currentState.currentPhoneActivation, null);
  } finally {
    Date.now = realDateNow;
  }
});

test('phone verification helper replaces the number when code submission returns to add-phone', async () => {
  const requests = [];
  const messages = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    verificationResendCount: 1,
    currentPhoneActivation: null,
    reusablePhoneActivation: null,
  };

  const numbers = [
    { activationId: '111111', phoneNumber: '66950000001' },
    { activationId: '222222', phoneNumber: '66950000002' },
  ];
  let numberIndex = 0;
  let submitCodeCount = 0;

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      const id = parsedUrl.searchParams.get('id');

      if (action === 'getPrices') {
        return { ok: true, text: async () => JSON.stringify({ 52: { cost: '0.10' } }) };
      }
      if (action === 'getCountries') {
        return { ok: true, text: async () => JSON.stringify([{ id: 52, eng: 'Thailand', visible: 1 }]) };
      }
      if (action === 'getBalance') {
        return { ok: true, text: async () => 'ACCESS_BALANCE:5.0000' };
      }
      if (action === 'getNumber') {
        const nextNumber = numbers[numberIndex];
        numberIndex += 1;
        return {
          ok: true,
          text: async () => `ACCESS_NUMBER:${nextNumber.activationId}:${nextNumber.phoneNumber}`,
        };
      }
      if (action === 'getStatus') {
        return {
          ok: true,
          text: async () => 'STATUS_OK:654321',
        };
      }
      if (action === 'setStatus') {
        return {
          ok: true,
          text: async () => `STATUS_UPDATED:${id}`,
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}`);
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async (_source, message) => {
      messages.push(message.type);
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
        submitCodeCount += 1;
        return submitCodeCount === 1
          ? {
            returnedToAddPhone: true,
            url: 'https://auth.openai.com/add-phone',
          }
          : {
            success: true,
            consentReady: true,
            url: 'https://auth.openai.com/authorize',
          };
      }
      if (message.type === 'RESEND_PHONE_VERIFICATION_CODE') {
        return {
          resent: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      throw new Error(`Unexpected content-script message: ${message.type}`);
    },
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await helpers.completePhoneVerificationFlow(1, {
    addPhonePage: true,
    phoneVerificationPage: false,
    url: 'https://auth.openai.com/add-phone',
  });

  assert.deepStrictEqual(result, {
    success: true,
    consentReady: true,
    url: 'https://auth.openai.com/authorize',
  });
  assert.deepStrictEqual(messages, [
    'SUBMIT_PHONE_NUMBER',
    'SUBMIT_PHONE_VERIFICATION_CODE',
    'SUBMIT_PHONE_NUMBER',
    'SUBMIT_PHONE_VERIFICATION_CODE',
  ]);

  const actions = requests.map((url) => `${url.searchParams.get('action')}:${url.searchParams.get('id') || ''}`);
  assert.deepStrictEqual(actions, [
    'getPrices:',
    'getCountries:',
    'getBalance:',
    'getNumber:',
    'getStatus:111111',
    'setStatus:111111',
    'getPrices:',
    'getCountries:',
    'getBalance:',
    'getNumber:',
    'getStatus:222222',
    'setStatus:222222',
  ]);
  assert.deepStrictEqual(currentState.currentPhoneActivation, null);
  assert.deepStrictEqual(currentState.reusablePhoneActivation, {
    activationId: '222222',
    phoneNumber: '66950000002',
    provider: 'hero-sms',
    serviceCode: 'dr',
    countryId: 52,
    successfulUses: 1,
    maxUses: 3,
  });
});

test('phone verification helper reuses the same number up to three successful registrations', async () => {
  const requests = [];
  let currentState = {
    heroSmsApiKey: 'demo-key',
    verificationResendCount: 0,
    currentPhoneActivation: null,
    reusablePhoneActivation: {
      activationId: '123456',
      phoneNumber: '66959916439',
      provider: 'hero-sms',
      serviceCode: 'dr',
      countryId: 52,
      successfulUses: 2,
      maxUses: 3,
    },
  };

  const helpers = api.createPhoneVerificationHelpers({
    addLog: async () => {},
    ensureStep8SignupPageReady: async () => {},
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl);
      const action = parsedUrl.searchParams.get('action');
      if (action === 'reactivate') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            activationId: '222333',
            phoneNumber: '66959916439',
          }),
        };
      }
      if (action === 'getStatus') {
        return {
          ok: true,
          text: async () => 'STATUS_OK:654321',
        };
      }
      if (action === 'setStatus') {
        return {
          ok: true,
          text: async () => 'ACCESS_ACTIVATION',
        };
      }
      throw new Error(`Unexpected HeroSMS action: ${action}`);
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getState: async () => ({ ...currentState }),
    sendToContentScriptResilient: async (_source, message) => {
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'SUBMIT_PHONE_VERIFICATION_CODE') {
        return {
          success: true,
          consentReady: true,
          url: 'https://auth.openai.com/authorize',
        };
      }
      throw new Error(`Unexpected content-script message: ${message.type}`);
    },
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await helpers.completePhoneVerificationFlow(1, {
    addPhonePage: true,
    phoneVerificationPage: false,
    url: 'https://auth.openai.com/add-phone',
  });

  assert.deepStrictEqual(result, {
    success: true,
    consentReady: true,
    url: 'https://auth.openai.com/authorize',
  });
  assert.equal(requests[0].searchParams.get('action'), 'reactivate');
  assert.equal(requests[0].searchParams.get('id'), '123456');
  assert.deepStrictEqual(currentState.reusablePhoneActivation, null);
});
