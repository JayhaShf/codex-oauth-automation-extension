(function attachBackgroundPhoneVerification(root, factory) {
  root.MultiPageBackgroundPhoneVerification = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPhoneVerificationModule() {
  function createPhoneVerificationHelpers(deps = {}) {
    const {
      addLog,
      broadcastDataUpdate = () => {},
      ensureStep8SignupPageReady,
      fetchImpl = (...args) => fetch(...args),
      getOAuthFlowStepTimeoutMs,
      getState,
      sendToContentScriptResilient,
      setState,
      sleepWithStop,
      throwIfStopped,
      DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php',
      HERO_SMS_COUNTRY_ID = 52,
      HERO_SMS_COUNTRY_LABEL = 'Thailand',
      HERO_SMS_SERVICE_CODE = 'dr',
      HERO_SMS_SERVICE_LABEL = 'OpenAI',
    } = deps;

    const PHONE_ACTIVATION_STATE_KEY = 'currentPhoneActivation';
    const REUSABLE_PHONE_ACTIVATION_STATE_KEY = 'reusablePhoneActivation';
    const DEFAULT_PHONE_POLL_INTERVAL_MS = 5000;
    const DEFAULT_PHONE_POLL_TIMEOUT_MS = 180000;
    const DEFAULT_PHONE_REQUEST_TIMEOUT_MS = 20000;
    const DEFAULT_PHONE_SUBMIT_ATTEMPTS = 3;
    const DEFAULT_PHONE_CODE_WAIT_WINDOW_MS = 60000;
    const DEFAULT_PHONE_CODE_DELAY_SECONDS = 0;
    const DEFAULT_PHONE_NUMBER_MAX_USES = 3;
    const DEFAULT_COUNTRY_SMS_FAILURE_LIMIT = 3;
    const PHONE_CODE_TIMEOUT_ERROR_PREFIX = 'PHONE_CODE_TIMEOUT::';
    const PHONE_RESTART_STEP7_ERROR_PREFIX = 'PHONE_RESTART_STEP7::';

    function normalizeUrl(value, fallback = DEFAULT_HERO_SMS_BASE_URL) {
      const trimmed = String(value || '').trim();
      if (!trimmed) {
        return fallback;
      }
      try {
        return new URL(trimmed).toString();
      } catch {
        return fallback;
      }
    }

    function normalizeApiKey(value) {
      return String(value || '').trim();
    }

    function normalizeUseCount(value) {
      return Math.max(0, Math.floor(Number(value) || 0));
    }

    function normalizeMaxPrice(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
    }

    function normalizeCodeDelaySeconds(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric)
        ? Math.max(0, Math.min(300, Math.floor(numeric)))
        : DEFAULT_PHONE_CODE_DELAY_SECONDS;
    }

    function resolveCountryConfig(state = {}) {
      return {
        id: Math.max(1, Math.floor(Number(state.heroSmsCountryId) || HERO_SMS_COUNTRY_ID)),
        label: String(state.heroSmsCountryLabel || HERO_SMS_COUNTRY_LABEL).trim() || HERO_SMS_COUNTRY_LABEL,
      };
    }

    function normalizeActivation(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
      }
      const activationId = String(
        record.activationId ?? record.id ?? record.activation ?? ''
      ).trim();
      const phoneNumber = String(
        record.phoneNumber ?? record.number ?? record.phone ?? ''
      ).trim();
      if (!activationId || !phoneNumber) {
        return null;
      }
      return {
        activationId,
        phoneNumber,
        provider: String(record.provider || 'hero-sms').trim() || 'hero-sms',
        serviceCode: String(record.serviceCode || HERO_SMS_SERVICE_CODE).trim() || HERO_SMS_SERVICE_CODE,
        countryId: Number(record.countryId) || HERO_SMS_COUNTRY_ID,
        successfulUses: normalizeUseCount(record.successfulUses),
        maxUses: Math.max(1, Math.floor(Number(record.maxUses) || DEFAULT_PHONE_NUMBER_MAX_USES)),
      };
    }

    function describeHeroSmsPayload(raw) {
      if (typeof raw === 'string') {
        return raw.trim();
      }
      if (raw && typeof raw === 'object') {
        if (raw.title || raw.details) {
          const title = String(raw.title || '').trim();
          const details = String(raw.details || '').trim();
          return details ? `${title}: ${details}` : title;
        }
        if (raw.status === 'false' && raw.msg) {
          return String(raw.msg).trim();
        }
        try {
          return JSON.stringify(raw);
        } catch {
          return String(raw);
        }
      }
      return String(raw || '').trim();
    }

    function parseHeroSmsPayload(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        return '';
      }
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    }

    function extractHeroSmsCountryPrices(payload) {
      const countryPrices = new Map();

      function addCountryPrice(countryValue, priceValue) {
        const normalizedId = Math.max(1, Math.floor(Number(countryValue) || 0));
        const numericPrice = Number(priceValue);
        if (!(normalizedId > 0) || !Number.isFinite(numericPrice) || numericPrice < 0) {
          return;
        }
        const previousPrice = countryPrices.get(normalizedId);
        if (previousPrice === undefined || numericPrice < previousPrice) {
          countryPrices.set(normalizedId, numericPrice);
        }
      }

      function walk(value, path = []) {
        if (!value || typeof value !== 'object') {
          return;
        }

        if (Array.isArray(value)) {
          value.forEach((item) => walk(item, path));
          return;
        }

        const pathSet = new Set(path.map((segment) => String(segment || '').toLowerCase()));
        const directCountryId = value.country ?? value.countryId ?? value.country_id ?? value.id;
        const directPrice = value.cost ?? value.price;
        if (directPrice !== undefined && directCountryId !== undefined) {
          addCountryPrice(directCountryId, directPrice);
        }

        Object.entries(value).forEach(([key, nestedValue]) => {
          const lowerKey = String(key || '').toLowerCase();
          const nextPath = path.concat(key);

          if (path.length === 0 && /^\d+$/.test(lowerKey) && nestedValue && typeof nestedValue === 'object') {
            addCountryPrice(lowerKey, nestedValue.cost ?? nestedValue.price);
          }

          if (pathSet.has('countries') || pathSet.has('country') || pathSet.has('value')) {
            if (/^\d+$/.test(lowerKey) && nestedValue && typeof nestedValue === 'object') {
              addCountryPrice(lowerKey, nestedValue.cost ?? nestedValue.price);
            }
          }

          if ((lowerKey === 'countries' || lowerKey === 'country') && nestedValue && typeof nestedValue === 'object') {
            Object.entries(nestedValue).forEach(([countryKey, countryValue]) => {
              if (/^\d+$/.test(String(countryKey || '').trim()) && countryValue && typeof countryValue === 'object') {
                addCountryPrice(countryKey, countryValue.cost ?? countryValue.price);
              }
            });
          }

          walk(nestedValue, nextPath);
        });
      }

      walk(payload);
      return countryPrices;
    }

    function extractHeroSmsCountryLabels(payload) {
      const entries = Array.isArray(payload?.value) ? payload.value : (Array.isArray(payload) ? payload : []);
      return new Map(
        entries
          .filter((item) => Number(item?.id) > 0 && String(item?.eng || '').trim())
          .map((item) => [Math.max(1, Math.floor(Number(item.id) || 0)), String(item.eng || '').trim()])
      );
    }

    function parseHeroSmsBalance(payload) {
      const text = describeHeroSmsPayload(payload);
      const accessMatch = text.match(/^ACCESS_BALANCE:([0-9.]+)$/i);
      if (accessMatch) {
        const numeric = Number(accessMatch[1]);
        return Number.isFinite(numeric) ? numeric : null;
      }
      if (payload && typeof payload === 'object') {
        const numeric = Number(payload.balance ?? payload.value ?? payload.amount);
        return Number.isFinite(numeric) ? numeric : null;
      }
      const numeric = Number(text);
      return Number.isFinite(numeric) ? numeric : null;
    }

    function resolveHeroSmsCountryRegion(label = '') {
      const normalizedLabel = String(label || '').trim().toLowerCase();
      if (!normalizedLabel) {
        return '';
      }

      if ([
        'united kingdom', 'ireland', 'germany', 'france', 'netherlands', 'spain', 'italy', 'poland',
        'romania', 'sweden', 'austria', 'belgium', 'portugal', 'czech', 'croatia', 'lithuania',
        'latvia', 'estonia', 'slovakia', 'slovenia', 'hungary', 'bulgaria', 'switzerland',
        'denmark', 'norway', 'finland', 'greece', 'cyprus', 'luxembourg', 'malta', 'gibraltar',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'europe';
      }

      if ([
        'thailand', 'vietnam', 'indonesia', 'malaysia', 'philippines', 'myanmar', 'china', 'hong kong',
        'macao', 'india', 'cambodia', 'laos', 'taiwan', 'japan', 'singapore', 'pakistan', 'bangladesh',
        'sri lanka', 'nepal', 'mongolia', 'south korea', 'north korea',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'asia';
      }

      if ([
        'usa', 'canada', 'mexico', 'jamaica', 'puerto rico', 'trinidad and tobago', 'costa rica', 'guatemala',
        'panama', 'cuba', 'barbados', 'bahamas', 'belize', 'dominican republic', 'dominica', 'grenada',
        'saint kitts and nevis', 'saint lucia', 'saint vincent and the grenadines', 'antigua and barbuda',
        'cayman islands', 'montserrat', 'anguilla', 'honduras', 'nicaragua', 'salvador',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'north-america';
      }

      if ([
        'brazil', 'argentina', 'colombia', 'peru', 'venezuela', 'chile', 'uruguay', 'paraguay', 'ecuador',
        'bolivia', 'guyana', 'suriname', 'french guiana',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'south-america';
      }

      if ([
        'nigeria', 'kenya', 'tanzania', 'south africa', 'morocco', 'ghana', 'cameroon', 'chad', 'uganda',
        'egypt', 'algeria', 'senegal', 'guinea', 'mali', 'ethiopia', 'angola', 'mozambique', 'zimbabwe',
        'sudan', 'togo', 'mauritania', 'sierra leone', 'burundi', 'benin', 'botswana',
        'central african republic', 'guinea-bissau', 'comoros', 'liberia', 'lesotho', 'malawi',
        'namibia', 'niger', 'rwanda', 'reunion', 'zambia', 'somalia', 'gabon', 'mauritius',
        'djibouti', 'equatorial guinea', 'eritrea', 'south sudan', 'sao tome and principe', 'cape verde',
        'swaziland', 'ivory coast', 'gambia', 'madagascar', 'dr congo', 'congo', 'burkina faso',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'africa';
      }

      if ([
        'saudi arabia', 'israel', 'iraq', 'iran', 'turkey', 'uae', 'kuwait', 'oman', 'qatar', 'syria',
        'jordan', 'bahrain', 'palestine', 'lebanon', 'yemen', 'afghanistan',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'middle-east';
      }

      if ([
        'australia', 'new zealand', 'papua', 'fiji', 'samoa', 'tonga', 'solomon islands', 'new caledonia', 'niue',
      ].some((name) => normalizedLabel.includes(name))) {
        return 'oceania';
      }

      return '';
    }

    function isHeroSmsNoStockText(value = '') {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue) {
        return false;
      }
      return [
        /NO_NUMBERS/i,
        /no\s+numbers?/i,
        /no\s+activations?/i,
        /out\s+of\s+stock/i,
        /not\s+available/i,
      ].some((pattern) => pattern.test(normalizedValue));
    }

    function isHeroSmsNoNumbersPayload(payload) {
      return isHeroSmsNoStockText(describeHeroSmsPayload(payload));
    }

    function isHeroSmsNoNumbersError(error) {
      return Boolean(error?.heroSmsNoStock) || isHeroSmsNoStockText(error?.message || '');
    }

    function buildHeroSmsUrl(baseUrl, query = {}) {
      const url = new URL(normalizeUrl(baseUrl));
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') {
          return;
        }
        url.searchParams.set(key, String(value));
      });
      return url.toString();
    }

    function buildPhoneCodeTimeoutError(lastResponse = '') {
      const suffix = lastResponse ? ` Last HeroSMS status: ${lastResponse}` : '';
      return new Error(`${PHONE_CODE_TIMEOUT_ERROR_PREFIX}Timed out waiting for the phone verification code.${suffix}`);
    }

    function isPhoneCodeTimeoutError(error) {
      return String(error?.message || '').startsWith(PHONE_CODE_TIMEOUT_ERROR_PREFIX);
    }

    function buildPhoneRestartStep7Error(phoneNumber = '') {
      const suffix = phoneNumber ? ` Current number: ${phoneNumber}.` : '';
      return new Error(
        `${PHONE_RESTART_STEP7_ERROR_PREFIX}Phone verification could not receive an SMS after resend. Restart step 7 with a new number.${suffix}`
      );
    }

    function sanitizePhoneCodeTimeoutError(error) {
      const message = String(error?.message || '');
      if (!message.startsWith(PHONE_CODE_TIMEOUT_ERROR_PREFIX)) {
        return error;
      }
      return new Error(message.slice(PHONE_CODE_TIMEOUT_ERROR_PREFIX.length).trim() || 'Timed out waiting for the phone verification code.');
    }

    function sanitizePhoneRestartStep7Error(error) {
      const message = String(error?.message || '');
      if (!message.startsWith(PHONE_RESTART_STEP7_ERROR_PREFIX)) {
        return error;
      }
      return new Error(
        message.slice(PHONE_RESTART_STEP7_ERROR_PREFIX.length).trim()
        || 'Phone verification could not receive an SMS after resend. Restart step 7 with a new number.'
      );
    }

    async function fetchHeroSmsPayload(config, query, actionLabel) {
      const requestUrl = buildHeroSmsUrl(config.baseUrl, {
        api_key: config.apiKey,
        ...query,
      });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), DEFAULT_PHONE_REQUEST_TIMEOUT_MS)
        : null;

      try {
        const response = await fetchImpl(requestUrl, {
          method: 'GET',
          signal: controller?.signal,
        });
        const text = await response.text();
        const payload = parseHeroSmsPayload(text);
        if (!response.ok) {
          throw new Error(`${actionLabel} failed: ${describeHeroSmsPayload(payload) || response.status}`);
        }
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`${actionLabel} timed out.`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    function resolvePhoneConfig(state = {}) {
      const apiKey = normalizeApiKey(state.heroSmsApiKey);
      if (!apiKey) {
        throw new Error('HeroSMS API key is missing. Save it in the side panel before running the phone flow.');
      }
      return {
        apiKey,
        baseUrl: normalizeUrl(state.heroSmsBaseUrl, DEFAULT_HERO_SMS_BASE_URL),
      };
    }

    async function fetchHeroSmsCountryPrices(config) {
      const payload = await fetchHeroSmsPayload(config, {
        action: 'getPrices',
        service: HERO_SMS_SERVICE_CODE,
      }, 'HeroSMS getPrices');
      return extractHeroSmsCountryPrices(payload);
    }

    async function fetchHeroSmsCountryLabels(config) {
      const payload = await fetchHeroSmsPayload(config, {
        action: 'getCountries',
      }, 'HeroSMS getCountries');
      return extractHeroSmsCountryLabels(payload);
    }

    async function queryHeroSmsBalance(state = {}) {
      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'getBalance',
      }, 'HeroSMS getBalance');
      const balance = parseHeroSmsBalance(payload);
      await setState({ heroSmsBalance: balance });
      broadcastDataUpdate({ heroSmsBalance: balance });
      return balance;
    }

    async function persistSelectedCountry(countryConfig) {
      const payload = {
        heroSmsCountryId: countryConfig.id,
        heroSmsCountryLabel: countryConfig.label,
      };
      await setState(payload);
      broadcastDataUpdate(payload);
    }

    async function collectPurchasableCountries(state = {}) {
      const config = resolvePhoneConfig(state);
      const maxPrice = normalizeMaxPrice(state.heroSmsMaxPrice);
      const [countryPrices, countryLabels] = await Promise.all([
        fetchHeroSmsCountryPrices(config),
        fetchHeroSmsCountryLabels(config).catch(() => new Map()),
      ]);
      return Array.from(countryPrices.entries())
        .filter(([, price]) => maxPrice === null || price <= maxPrice)
        .map(([countryId, price]) => ({
          id: countryId,
          label: countryLabels.get(countryId) || `Country ${countryId}`,
          price,
          region: resolveHeroSmsCountryRegion(countryLabels.get(countryId) || `Country ${countryId}`),
        }));
    }

    function pickBestHeroSmsCountry(state = {}, candidates = [], excludedCountryIds = []) {
      const excluded = new Set(excludedCountryIds.map((value) => Math.max(1, Math.floor(Number(value) || 0))));
      const currentCountryId = Math.max(1, Math.floor(Number(state.heroSmsCountryId) || 0));
      const currentRegion = resolveHeroSmsCountryRegion(state.heroSmsCountryLabel);
      const filteredCandidates = candidates.filter((candidate) => !excluded.has(candidate.id));
      const currentCandidate = filteredCandidates.find((candidate) => candidate.id === currentCountryId);
      if (currentCandidate) {
        return currentCandidate;
      }
      return filteredCandidates
        .sort((left, right) => {
          const sameRegionLeft = currentRegion && left.region === currentRegion ? 1 : 0;
          const sameRegionRight = currentRegion && right.region === currentRegion ? 1 : 0;
          if (sameRegionLeft !== sameRegionRight) {
            return sameRegionRight - sameRegionLeft;
          }
          return left.price - right.price || left.id - right.id;
        })[0] || null;
    }

    async function ensureHeroSmsPurchaseReady(state = {}, options = {}) {
      const {
        excludedCountryIds = [],
        logSelection = false,
        selectionReason = '自动筛选可买国家',
        allowFallbackCurrent = true,
        allowBalanceCheckFailure = true,
      } = options;
      let candidates = [];
      try {
        candidates = await collectPurchasableCountries(state);
      } catch (error) {
        if (!allowFallbackCurrent) {
          throw error;
        }
      }

      let selectedCountry = candidates.length > 0
        ? pickBestHeroSmsCountry(state, candidates, excludedCountryIds)
        : null;
      if (!selectedCountry && allowFallbackCurrent) {
        const currentCountry = resolveCountryConfig(state);
        const excluded = new Set(excludedCountryIds.map((value) => Math.max(1, Math.floor(Number(value) || 0))));
        if (!excluded.has(currentCountry.id)) {
          selectedCountry = {
            id: currentCountry.id,
            label: currentCountry.label,
            price: null,
            region: resolveHeroSmsCountryRegion(currentCountry.label),
          };
        }
      }
      if (!selectedCountry) {
        throw new Error('HeroSMS 当前没有符合价格阈值且可购买的国家。');
      }

      if (
        resolveCountryConfig(state).id !== selectedCountry.id
        || resolveCountryConfig(state).label !== selectedCountry.label
      ) {
        if (logSelection) {
          const priceText = Number.isFinite(selectedCountry.price)
            ? `$${selectedCountry.price.toFixed(4)}`
            : '价格未知';
          await addLog(
            `Step 9: ${selectionReason}，切换到 ${selectedCountry.label}，当前${priceText}。`,
            'info'
          );
        }
        await persistSelectedCountry(selectedCountry);
      }

      let balance = (state.heroSmsBalance === null || state.heroSmsBalance === undefined)
        ? null
        : Number(state.heroSmsBalance);
      if (!Number.isFinite(balance)) {
        balance = null;
      }
      try {
        balance = await queryHeroSmsBalance({
          ...state,
          heroSmsCountryId: selectedCountry.id,
          heroSmsCountryLabel: selectedCountry.label,
        });
      } catch (error) {
        if (!allowBalanceCheckFailure) {
          throw error;
        }
        await addLog(`Step 9: failed to query HeroSMS balance before purchase. ${error.message}`, 'warn');
      }
      if (Number.isFinite(balance) && Number.isFinite(selectedCountry.price) && balance < selectedCountry.price) {
        throw new Error(
          `HeroSMS 余额不足。当前余额 $${balance.toFixed(4)}，${selectedCountry.label} 购买价格 $${selectedCountry.price.toFixed(4)}。`
        );
      }

      return {
        state: {
          ...state,
          heroSmsCountryId: selectedCountry.id,
          heroSmsCountryLabel: selectedCountry.label,
          heroSmsBalance: balance,
        },
        country: selectedCountry,
        candidates,
        balance,
      };
    }

    async function pickAlternativeCountry(state = {}, excludedCountryIds = []) {
      const candidates = await collectPurchasableCountries(state);
      return pickBestHeroSmsCountry(state, candidates, excludedCountryIds);
    }

    function parseActivationPayload(payload, fallback = null) {
      const normalizedFallback = normalizeActivation(fallback);
      const directActivation = normalizeActivation(payload);
      if (directActivation) {
        return {
          ...directActivation,
          successfulUses: normalizedFallback?.successfulUses || directActivation.successfulUses,
          maxUses: normalizedFallback?.maxUses || directActivation.maxUses,
        };
      }

      const text = describeHeroSmsPayload(payload);
      const accessNumberMatch = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
      if (accessNumberMatch) {
        return {
          activationId: String(accessNumberMatch[1] || '').trim(),
          phoneNumber: String(accessNumberMatch[2] || '').trim(),
          provider: normalizedFallback?.provider || 'hero-sms',
          serviceCode: normalizedFallback?.serviceCode || HERO_SMS_SERVICE_CODE,
          countryId: normalizedFallback?.countryId || HERO_SMS_COUNTRY_ID,
          successfulUses: normalizedFallback?.successfulUses || 0,
          maxUses: normalizedFallback?.maxUses || DEFAULT_PHONE_NUMBER_MAX_USES,
        };
      }

      if (/^ACCESS_READY$/i.test(text) && normalizedFallback) {
        return normalizedFallback;
      }

      return null;
    }

    async function requestPhoneActivationForCountry(state = {}, countryConfig = resolveCountryConfig(state)) {
      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'getNumber',
        service: HERO_SMS_SERVICE_CODE,
        country: countryConfig.id,
      }, 'HeroSMS getNumber');

      const activation = parseActivationPayload(payload, {
        countryId: countryConfig.id,
      });
      if (!activation) {
        const text = describeHeroSmsPayload(payload);
        const error = new Error(
          `HeroSMS getNumber failed for ${countryConfig.label} (${countryConfig.id}): ${text || 'empty response'}`
        );
        if (isHeroSmsNoNumbersPayload(payload)) {
          error.heroSmsNoStock = true;
        }
        throw error;
      }

      return activation;
    }

    async function requestPhoneActivation(state = {}) {
      let currentState = { ...state };
      if (!currentState.heroSmsPurchasePrepared) {
        const initialSelection = await ensureHeroSmsPurchaseReady(currentState, {
          logSelection: true,
          selectionReason: '首次购买前自动筛选可买国家',
        });
        currentState = {
          ...initialSelection.state,
          heroSmsPurchasePrepared: true,
        };
      }
      let countryConfig = resolveCountryConfig(currentState);
      const attemptedCountryIds = new Set();

      while (true) {
        attemptedCountryIds.add(countryConfig.id);
        try {
          return await requestPhoneActivationForCountry(currentState, countryConfig);
        } catch (error) {
          if (!isHeroSmsNoNumbersError(error)) {
            throw error;
          }

          const nextSelection = await ensureHeroSmsPurchaseReady(currentState, {
            excludedCountryIds: Array.from(attemptedCountryIds),
            logSelection: true,
            selectionReason: `${countryConfig.label} 暂无号码池，自动切换可买国家`,
          }).catch(() => null);
          if (!nextSelection) {
            throw error;
          }
          currentState = {
            ...nextSelection.state,
            heroSmsPurchasePrepared: true,
          };
          countryConfig = nextSelection.country;
        }
      }
    }

    async function reactivatePhoneActivation(state = {}, activation) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Reusable phone activation is missing.');
      }

      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'reactivate',
        id: normalizedActivation.activationId,
      }, 'HeroSMS reactivate');
      const nextActivation = parseActivationPayload(payload, normalizedActivation);
      if (!nextActivation) {
        const text = describeHeroSmsPayload(payload);
        throw new Error(`HeroSMS reactivate failed: ${text || 'empty response'}`);
      }
      return nextActivation;
    }

    async function setPhoneActivationStatus(state = {}, activation, status, actionLabel) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        return '';
      }
      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'setStatus',
        id: normalizedActivation.activationId,
        status,
      }, actionLabel);
      return describeHeroSmsPayload(payload);
    }

    async function completePhoneActivation(state = {}, activation) {
      await setPhoneActivationStatus(state, activation, 6, 'HeroSMS setStatus(6)');
    }

    async function cancelPhoneActivation(state = {}, activation) {
      try {
        await setPhoneActivationStatus(state, activation, 8, 'HeroSMS setStatus(8)');
      } catch (_) {
        // Best-effort cleanup.
      }
    }

    async function requestAdditionalPhoneSms(state = {}, activation) {
      try {
        await setPhoneActivationStatus(state, activation, 3, 'HeroSMS setStatus(3)');
      } catch (_) {
        // Best-effort request only.
      }
    }

    async function pollPhoneActivationCode(state = {}, activation, options = {}) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Phone activation is missing.');
      }

      const config = resolvePhoneConfig(state);
      const configuredTimeoutMs = Math.max(1000, Number(options.timeoutMs) || 0);
      const timeoutMs = configuredTimeoutMs || (
        typeof getOAuthFlowStepTimeoutMs === 'function'
          ? await getOAuthFlowStepTimeoutMs(
            DEFAULT_PHONE_POLL_TIMEOUT_MS,
            { step: 9, actionLabel: options.actionLabel || 'poll phone verification code' }
          )
          : DEFAULT_PHONE_POLL_TIMEOUT_MS
      );
      const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_PHONE_POLL_INTERVAL_MS);
      const start = Date.now();
      let lastResponse = '';
      let pollCount = 0;

      while (Date.now() - start < timeoutMs) {
        throwIfStopped();
        const payload = await fetchHeroSmsPayload(config, {
          action: 'getStatus',
          id: normalizedActivation.activationId,
        }, 'HeroSMS getStatus');
        const text = describeHeroSmsPayload(payload);
        lastResponse = text;
        pollCount += 1;

        if (typeof options.onStatus === 'function') {
          await options.onStatus({
            activation: normalizedActivation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText: text,
            timeoutMs,
          });
        }

        const okMatch = text.match(/^STATUS_OK:(.+)$/i);
        if (okMatch) {
          const rawCode = String(okMatch[1] || '').trim();
          const digitMatch = rawCode.match(/\b(\d{4,8})\b/);
          return digitMatch?.[1] || rawCode;
        }

        if (/^STATUS_(WAIT_CODE|WAIT_RETRY|WAIT_RESEND)$/i.test(text)) {
          await sleepWithStop(intervalMs);
          continue;
        }

        if (/^STATUS_CANCEL$/i.test(text)) {
          throw new Error('HeroSMS activation was cancelled before the SMS arrived.');
        }

        throw new Error(`HeroSMS getStatus failed: ${text || 'empty response'}`);
      }

      throw buildPhoneCodeTimeoutError(lastResponse);
    }

    async function readPhonePageState(tabId, timeoutMs = 10000) {
      await ensureStep8SignupPageReady(tabId, {
        timeoutMs,
        logMessage: 'Step 9: waiting for auth page content script to recover before phone verification.',
      });
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'STEP8_GET_STATE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: auth page is switching, waiting to inspect phone verification state again...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function submitPhoneNumber(tabId, phoneNumber) {
      const state = await getState();
      const countryConfig = resolveCountryConfig(state);
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'submit add-phone number' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'SUBMIT_PHONE_NUMBER',
        source: 'background',
        payload: {
          phoneNumber,
          countryId: countryConfig.id,
          countryLabel: countryConfig.label,
        },
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for add-phone page to become ready...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function submitPhoneVerificationCode(tabId, code) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(45000, { step: 9, actionLabel: 'submit phone verification code' })
        : 45000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'SUBMIT_PHONE_VERIFICATION_CODE',
        source: 'background',
        payload: { code },
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for phone verification page before filling the SMS code...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function resendPhoneVerificationCode(tabId) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'resend phone verification code' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'RESEND_PHONE_VERIFICATION_CODE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for the phone verification resend button...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function returnToAddPhone(tabId) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'return to add-phone page' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'RETURN_TO_ADD_PHONE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: returning to add-phone page to replace the phone number...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function persistCurrentActivation(activation) {
      await setState({
        [PHONE_ACTIVATION_STATE_KEY]: activation || null,
      });
    }

    async function persistReusableActivation(activation) {
      await setState({
        [REUSABLE_PHONE_ACTIVATION_STATE_KEY]: activation || null,
      });
    }

    async function clearCurrentActivation() {
      await persistCurrentActivation(null);
    }

    async function clearReusableActivation() {
      await persistReusableActivation(null);
    }

    async function acquirePhoneActivation(state = {}) {
      let currentState = { ...state };
      const countryConfig = resolveCountryConfig(currentState);
      const reusableActivation = normalizeActivation(state[REUSABLE_PHONE_ACTIVATION_STATE_KEY]);
      if (
        reusableActivation
        && reusableActivation.countryId === countryConfig.id
        && reusableActivation.successfulUses < reusableActivation.maxUses
      ) {
        try {
          const reactivated = await reactivatePhoneActivation(currentState, reusableActivation);
          await addLog(
            `Step 9: reusing ${countryConfig.label} number ${reactivated.phoneNumber} (${reactivated.successfulUses + 1}/${reactivated.maxUses}).`,
            'info'
          );
          return reactivated;
        } catch (error) {
          await addLog(`Step 9: failed to reuse phone number ${reusableActivation.phoneNumber}, falling back to a new number. ${error.message}`, 'warn');
          await clearReusableActivation();
        }
      } else if (reusableActivation && reusableActivation.countryId !== countryConfig.id) {
        await clearReusableActivation();
      }

      const readySelection = await ensureHeroSmsPurchaseReady(currentState);
      currentState = {
        ...readySelection.state,
        heroSmsPurchasePrepared: true,
      };
      const activation = await requestPhoneActivation(currentState);
      await addLog(
        `Step 9: acquired ${HERO_SMS_SERVICE_LABEL} / ${resolveCountryConfig(currentState).label} number ${activation.phoneNumber}.`,
        'info'
      );
      return activation;
    }

    async function markActivationReusableAfterSuccess(activation) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        await clearReusableActivation();
        return;
      }

      const successfulUses = normalizedActivation.successfulUses + 1;
      if (successfulUses >= normalizedActivation.maxUses) {
        await clearReusableActivation();
        return;
      }

      await persistReusableActivation({
        ...normalizedActivation,
        successfulUses,
      });
    }

    async function waitForPhoneCodeOrRotateNumber(tabId, state, activation, runtime = {}) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Phone activation is missing.');
      }

      const codeDelaySeconds = normalizeCodeDelaySeconds(state.heroSmsCodeDelaySeconds);
      if (codeDelaySeconds > 0) {
        await addLog(`Step 9: delaying SMS polling for ${codeDelaySeconds} seconds before checking ${normalizedActivation.phoneNumber}.`, 'info');
        await sleepWithStop(codeDelaySeconds * 1000);
      }

      let lastLoggedStatus = '';
      let lastLoggedPollCount = 0;

      for (let windowIndex = 1; windowIndex <= 2; windowIndex += 1) {
        await addLog(
          `Step 9: waiting up to 60 seconds for SMS on ${normalizedActivation.phoneNumber} (${windowIndex}/2).`,
          'info'
        );
        try {
          const code = await pollPhoneActivationCode(state, normalizedActivation, {
            actionLabel: windowIndex === 1
              ? 'poll phone verification code from HeroSMS'
              : 'poll resent phone verification code from HeroSMS',
            timeoutMs: DEFAULT_PHONE_CODE_WAIT_WINDOW_MS,
            onStatus: async ({ elapsedMs, pollCount, statusText }) => {
              const shouldLog = (
                pollCount === 1
                || statusText !== lastLoggedStatus
                || pollCount - lastLoggedPollCount >= 3
              );
              if (!shouldLog) {
                return;
              }
              lastLoggedStatus = statusText;
              lastLoggedPollCount = pollCount;
              await addLog(
                `Step 9: HeroSMS status for ${normalizedActivation.phoneNumber}: ${statusText} (${Math.ceil(elapsedMs / 1000)}s elapsed).`,
                'info'
              );
            },
          });
          return {
            code,
            replaceNumber: false,
          };
        } catch (error) {
          if (!isPhoneCodeTimeoutError(error)) {
            throw error;
          }

          if (windowIndex === 1) {
            await addLog(
              `Step 9: no SMS arrived for ${normalizedActivation.phoneNumber} within 60 seconds, requesting another SMS.`,
              'warn'
            );
            await requestAdditionalPhoneSms(state, normalizedActivation);
            try {
              await resendPhoneVerificationCode(tabId);
              await addLog('Step 9: clicked "Resend text message" on the phone verification page.', 'info');
            } catch (resendError) {
              await addLog(`Step 9: failed to click resend on the phone verification page. ${resendError.message}`, 'warn');
            }
            continue;
          }

          await addLog(
            `Step 9: still no SMS for ${normalizedActivation.phoneNumber} 60 seconds after resend, restarting from step 7 with a new number.`,
            'warn'
          );
          const nextFailureCount = (runtime.countrySmsFailureCounts?.get(normalizedActivation.countryId) || 0) + 1;
          runtime.countrySmsFailureCounts?.set(normalizedActivation.countryId, nextFailureCount);
          const shouldRotateCountry = nextFailureCount >= DEFAULT_COUNTRY_SMS_FAILURE_LIMIT;
          if (shouldRotateCountry) {
            const nextSelection = await ensureHeroSmsPurchaseReady(state, {
              excludedCountryIds: [normalizedActivation.countryId],
              logSelection: false,
            }).catch(() => null);
            if (nextSelection?.country) {
              await addLog(
                `Step 9: ${resolveCountryConfig(state).label} 已连续 ${DEFAULT_COUNTRY_SMS_FAILURE_LIMIT} 次收不到验证码，切换到 ${nextSelection.country.label}，当前价格 $${nextSelection.country.price.toFixed(4)}。`,
                'warn'
              );
              return {
                code: '',
                replaceNumber: true,
                nextCountry: nextSelection.country,
              };
            }
          }
          return {
            code: '',
            replaceNumber: true,
          };
        }
      }

      throw new Error('Phone verification did not complete successfully.');
    }

    async function completePhoneVerificationFlow(tabId, initialPageState = null) {
      let state = await getState();
      let activation = normalizeActivation(state[PHONE_ACTIVATION_STATE_KEY]);
      let pageState = initialPageState || await readPhonePageState(tabId);
      let shouldCancelActivation = false;
      let remainingResendRequests = Math.max(0, Number(state.verificationResendCount) || 0);
      const runtime = {
        countrySmsFailureCounts: new Map(),
      };

      try {
        while (true) {
          state = await getState();
          if (!activation) {
            activation = normalizeActivation(state[PHONE_ACTIVATION_STATE_KEY]);
          }

          if (pageState?.addPhonePage) {
            if (activation) {
              await cancelPhoneActivation(state, activation);
              await clearCurrentActivation();
              activation = null;
              shouldCancelActivation = false;
            }

            activation = await acquirePhoneActivation(state);
            shouldCancelActivation = true;
            await persistCurrentActivation(activation);
            const submitResult = await submitPhoneNumber(tabId, activation.phoneNumber);
            await addLog('Step 9: submitted the phone number on add-phone page.', 'info');
            pageState = {
              ...pageState,
              ...submitResult,
              addPhonePage: false,
              phoneVerificationPage: true,
            };
          }

          if (!pageState?.phoneVerificationPage) {
            pageState = await readPhonePageState(tabId);
          }

          if (!pageState?.phoneVerificationPage) {
            return pageState;
          }

          if (!activation) {
            throw new Error('The auth page is waiting for a phone verification code, but no HeroSMS activation is stored for this run.');
          }

          let shouldReplaceNumber = false;

          for (let attempt = 1; attempt <= DEFAULT_PHONE_SUBMIT_ATTEMPTS; attempt += 1) {
            throwIfStopped();

            const codeResult = await waitForPhoneCodeOrRotateNumber(tabId, state, activation, runtime);
            if (codeResult.replaceNumber) {
              shouldReplaceNumber = true;
              if (codeResult.nextCountry) {
                state = {
                  ...state,
                  heroSmsCountryId: codeResult.nextCountry.id,
                  heroSmsCountryLabel: codeResult.nextCountry.label,
                };
              }
              break;
            }

            await addLog(`Step 9: received phone verification code ${codeResult.code}.`, 'info');
            const submitResult = await submitPhoneVerificationCode(tabId, codeResult.code);

            if (submitResult.returnedToAddPhone) {
              await addLog(
                'Step 9: phone verification returned to add-phone after code submission, replacing the current number.',
                'warn'
              );
              shouldReplaceNumber = true;
              pageState = {
                ...pageState,
                ...submitResult,
                addPhonePage: true,
                phoneVerificationPage: false,
              };
              break;
            }

            if (submitResult.invalidCode) {
              if (attempt >= DEFAULT_PHONE_SUBMIT_ATTEMPTS) {
                throw new Error(
                  `Phone verification code was rejected after ${DEFAULT_PHONE_SUBMIT_ATTEMPTS} attempts: ${submitResult.errorText || submitResult.url || 'unknown error'}`
                );
              }

              if (remainingResendRequests > 0) {
                remainingResendRequests -= 1;
                await requestAdditionalPhoneSms(state, activation);
                try {
                  await resendPhoneVerificationCode(tabId);
                  await addLog('Step 9: clicked "Resend text message" after the phone code was rejected.', 'info');
                } catch (resendError) {
                  await addLog(`Step 9: failed to click resend after code rejection. ${resendError.message}`, 'warn');
                }
                await addLog(
                  `Step 9: phone verification code was rejected, requested another SMS (${remainingResendRequests} resend attempts left).`,
                  'warn'
                );
              } else {
                await addLog(
                  'Step 9: phone verification code was rejected and the configured resend budget is exhausted, retrying with the current activation window.',
                  'warn'
                );
              }
              continue;
            }

            await completePhoneActivation(state, activation);
            runtime.countrySmsFailureCounts.delete(activation.countryId);
            await markActivationReusableAfterSuccess(activation);
            shouldCancelActivation = false;
            await clearCurrentActivation();
          await addLog('Step 9: phone verification finished, waiting for OAuth consent.', 'ok');
          return submitResult;
        }

          if (!shouldReplaceNumber) {
            throw new Error('Phone verification did not complete successfully.');
          }

          if (!pageState?.addPhonePage) {
            const returnResult = await returnToAddPhone(tabId);
            pageState = {
              ...pageState,
              ...returnResult,
              addPhonePage: true,
              phoneVerificationPage: false,
            };
          }
        }
      } catch (error) {
        if (shouldCancelActivation && activation) {
          await cancelPhoneActivation(state, activation);
        }
        await clearCurrentActivation();
        throw sanitizePhoneRestartStep7Error(sanitizePhoneCodeTimeoutError(error));
      }
    }

    return {
      completePhoneVerificationFlow,
      normalizeActivation,
      pollPhoneActivationCode,
      queryHeroSmsBalance,
      reactivatePhoneActivation,
      requestPhoneActivation,
    };
  }

  return {
    createPhoneVerificationHelpers,
  };
});
