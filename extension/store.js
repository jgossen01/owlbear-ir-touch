/* Shared keys, defaults and storage helpers for the IR Touch extension (popover + background page). */
export const VERSION = '1.2.0';
export const CONFIG_KEY     = 'de.jensgossen.ir-touch/config'; // room metadata: settings published by the GM (the Cast window has no shared localStorage)
export const STATUS_CHANNEL = 'de.jensgossen.ir-touch/status'; // broadcast: status sent by the window that is the touch table
export const SETTINGS_KEY = 'ir_touch_settings'; // localStorage, per browser profile
export const REMOTE_KEY   = 'ir_touch_remote';   // localStorage: last status received from the touch table (GM windows)
export const HERE_KEY     = 'ir_touch_here';     // sessionStorage: "use THIS window as the touch table"
export const STATUS_KEY   = 'ir_touch_status';   // sessionStorage: status of THIS window, written by background.html
export const CAST_PLAYER_NAME = 'Cast Receiver'; // Owlbear names the Cast window's player like this
export const DEFAULT_SETTINGS = { enabled: false, port: 50000, displayInch: 0, displayWidthMm: 0, physicalScale: true, snap: false, autoCast: true };

function read(store, key, fallback) { try { const v = JSON.parse(store.getItem(key) || 'null'); return v ?? fallback; } catch (_) { return fallback; } }
function write(store, key, value) { try { value === null ? store.removeItem(key) : store.setItem(key, JSON.stringify(value)); } catch (_) {} }

export const hasOwnSettings = () => { try { return localStorage.getItem(SETTINGS_KEY) !== null; } catch (_) { return false; } };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(localStorage, SETTINGS_KEY, {}) });
export const setSettings = patch => write(localStorage, SETTINGS_KEY, { ...getSettings(), ...patch });
export const getRemote = () => read(localStorage, REMOTE_KEY, null);
export const setRemote = st => write(localStorage, REMOTE_KEY, st);
export const getHere = () => !!read(sessionStorage, HERE_KEY, false);
export const setHere = v => write(sessionStorage, HERE_KEY, !!v);
export const getStatus = () => read(sessionStorage, STATUS_KEY, { active: false });
export const setStatus = patch => write(sessionStorage, STATUS_KEY, { ...getStatus(), ...patch, updatedAt: Date.now() });
export const inchToWidthMm = inch => Math.round(inch * 25.4 * 16 / Math.sqrt(16 * 16 + 9 * 9)); // 16:9 picture width
