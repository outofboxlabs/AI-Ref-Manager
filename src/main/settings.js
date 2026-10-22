// App settings stored in settings.json. The API key is encrypted with the
// OS keychain (Electron safeStorage) when available.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  model: 'claude-opus-5-5',
  citationStyle: 'apa',
  autoMetadata: true,
  autoSummarize: false,
  onlineLookup: true,
};

class Settings {
  constructor(dataDir, safeStorage) {
    this.path = path.join(dataDir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = { ...DEFAULTS };
    if (fs.existsSync(this.path)) {
      try {
        this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.path, 'utf8')) };
      } catch {
        /* fall back to defaults on a corrupt file */
      }
    }
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  canEncrypt() {
    try {
      return !!this.safeStorage && this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  getApiKey() {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    const { apiKeyEnc, apiKeyPlain } = this.data;
    if (apiKeyEnc && this.canEncrypt()) {
      try {
        return this.safeStorage.decryptString(Buffer.from(apiKeyEnc, 'base64'));
      } catch {
        return '';
      }
    }
    return apiKeyPlain || '';
  }

  setApiKey(key) {
    delete this.data.apiKeyEnc;
    delete this.data.apiKeyPlain;
    const k = String(key || '').trim();
    if (k) {
      if (this.canEncrypt()) this.data.apiKeyEnc = this.safeStorage.encryptString(k).toString('base64');
      else this.data.apiKeyPlain = k;
    }
    this.save();
  }

  /** Settings safe to send to the renderer (never the key itself). */
  public() {
    const key = this.getApiKey();
    return {
      model: this.data.model,
      citationStyle: this.data.citationStyle,
      autoMetadata: this.data.autoMetadata,
      autoSummarize: this.data.autoSummarize,
      onlineLookup: this.data.onlineLookup,
      hasApiKey: !!key,
      apiKeyHint: key ? `…${key.slice(-4)}` : '',
      apiKeyFromEnv: !!process.env.ANTHROPIC_API_KEY,
      keyEncrypted: !!this.data.apiKeyEnc,
    };
  }

  update(patch) {
    for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) this.data[k] = patch[k];
    if (patch.apiKey !== undefined) this.setApiKey(patch.apiKey);
    else this.save();
    return this.public();
  }

  ai() {
    return { apiKey: this.getApiKey(), model: this.data.model };
  }
}

module.exports = { Settings, DEFAULTS };
